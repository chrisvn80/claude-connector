import { google } from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Accounts, GoogleAccount } from "../accounts.js";
import { ACCOUNT_DESC, ACCOUNT_OR_ALL_DESC, READ, WRITE_ADD, WRITE_CHANGE, fanOut, guarded } from "./common.js";

// ============================================================
// Drive (search + read), Docs (create, append, replace),
// Sheets (read, write, append, create). No delete tools.
// ============================================================

const GDOC = "application/vnd.google-apps.document";
const GSHEET = "application/vnd.google-apps.spreadsheet";
const GSLIDES = "application/vnd.google-apps.presentation";

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function registerDriveDocsSheetsTools(server: McpServer, accounts: Accounts, relinkUrl: string) {
  const drive = (a: GoogleAccount) => google.drive({ version: "v3", auth: accounts.googleAuth(a) });
  const docs = (a: GoogleAccount) => google.docs({ version: "v1", auth: accounts.googleAuth(a) });
  const sheets = (a: GoogleAccount) => google.sheets({ version: "v4", auth: accounts.googleAuth(a) });

  // ---------------- Drive ----------------

  server.registerTool(
    "drive_search",
    {
      title: "Search Google Drive",
      description: `Search files (including shared drives) in one or all accounts.
"query" does a full-text + name search. "type" narrows to doc/sheet/slides/pdf/folder.
Advanced: pass raw Drive query syntax in "drive_q" (e.g. "modifiedTime > '2026-11-01T00:00:00'").`,
      inputSchema: {
        account: z.string().default("all").describe(ACCOUNT_OR_ALL_DESC),
        query: z.string().optional(),
        type: z.enum(["any", "doc", "sheet", "slides", "pdf", "folder"]).default("any"),
        drive_q: z.string().optional(),
        max_results: z.number().int().min(1).max(100).default(20).describe("Per account")
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, query, type, drive_q, max_results }) => {
      const targets = await accounts.resolveGoogle(account, true);
      const parts = ["trashed = false"];
      if (query) parts.push(`(fullText contains '${escapeQ(query)}' or name contains '${escapeQ(query)}')`);
      const mime: Record<string, string> = {
        doc: GDOC,
        sheet: GSHEET,
        slides: GSLIDES,
        pdf: "application/pdf",
        folder: "application/vnd.google-apps.folder"
      };
      if (type !== "any") parts.push(`mimeType = '${mime[type]}'`);
      if (drive_q) parts.push(`(${drive_q})`);
      const q = parts.join(" and ");
      const { results, failed } = await fanOut(
        targets,
        (a) => a.label,
        async (a) => {
          const r = await drive(a).files.list({
            q,
            pageSize: max_results,
            corpora: "allDrives",
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            orderBy: query ? undefined : "modifiedTime desc",
            fields: "files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size)"
          });
          return (r.data.files ?? []).map((f) => ({
            account: a.label,
            id: f.id,
            name: f.name,
            type: f.mimeType,
            modified: f.modifiedTime,
            owner: f.owners?.[0]?.emailAddress,
            link: f.webViewLink
          }));
        },
        relinkUrl
      );
      return { accounts_failed: failed, files: results.flatMap((r) => r.value) };
    })
  );

  server.registerTool(
    "drive_read_file",
    {
      title: "Read a Drive file",
      description: `Read a file's text. Google Docs and Slides come back as plain text; Google Sheets as CSV of the
first tab (use sheets_read_range for other tabs or exact ranges); plain-text/CSV/JSON/Markdown files as-is.
Other types (PDF, Office files, images) return metadata and a link only.`,
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        file_id: z.string()
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, file_id }) => {
      const a = await accounts.resolveOneGoogle(account);
      const d = drive(a);
      const meta = await d.files.get({
        fileId: file_id,
        supportsAllDrives: true,
        fields: "id,name,mimeType,modifiedTime,webViewLink,size"
      });
      const m = meta.data;
      const base = { account: a.label, id: m.id, name: m.name, type: m.mimeType, modified: m.modifiedTime, link: m.webViewLink };
      const exportAs: Record<string, string> = { [GDOC]: "text/plain", [GSLIDES]: "text/plain", [GSHEET]: "text/csv" };
      if (m.mimeType && exportAs[m.mimeType]) {
        const r = await d.files.export({ fileId: file_id, mimeType: exportAs[m.mimeType] }, { responseType: "text" });
        return { ...base, content: String(r.data) };
      }
      const textual = /^(text\/|application\/(json|xml|x-yaml|javascript))/.test(m.mimeType ?? "");
      if (textual && Number(m.size ?? 0) < 5_000_000) {
        const r = await d.files.get({ fileId: file_id, alt: "media", supportsAllDrives: true }, { responseType: "text" });
        return { ...base, content: String(r.data) };
      }
      return { ...base, content: null, note: "This file type can't be read as text here. Open it via the link." };
    })
  );

  // ---------------- Docs ----------------

  server.registerTool(
    "docs_create",
    {
      title: "Create Google Doc",
      description: "Create a new Google Doc in the account's My Drive, optionally with initial plain-text content.",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        title: z.string(),
        content: z.string().optional()
      },
      annotations: WRITE_ADD
    },
    guarded(relinkUrl, async ({ account, title, content }) => {
      const a = await accounts.resolveOneGoogle(account);
      const dc = docs(a);
      const created = await dc.documents.create({ requestBody: { title } });
      const id = created.data.documentId!;
      if (content) {
        await dc.documents.batchUpdate({
          documentId: id,
          requestBody: { requests: [{ insertText: { location: { index: 1 }, text: content } }] }
        });
      }
      return { account: a.label, document_id: id, title, link: `https://docs.google.com/document/d/${id}/edit` };
    })
  );

  server.registerTool(
    "docs_append_text",
    {
      title: "Append to Google Doc",
      description: "Append plain text to the end of an existing Google Doc.",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        document_id: z.string(),
        text: z.string()
      },
      annotations: WRITE_ADD
    },
    guarded(relinkUrl, async ({ account, document_id, text }) => {
      const a = await accounts.resolveOneGoogle(account);
      const dc = docs(a);
      const doc = await dc.documents.get({ documentId: document_id, fields: "body.content(endIndex),title" });
      const end = Math.max(1, (doc.data.body?.content?.at(-1)?.endIndex ?? 2) - 1);
      await dc.documents.batchUpdate({
        documentId: document_id,
        requestBody: { requests: [{ insertText: { location: { index: end }, text: text.startsWith("\n") ? text : `\n${text}` } }] }
      });
      return { account: a.label, document_id, title: doc.data.title, appended_chars: text.length };
    })
  );

  server.registerTool(
    "docs_replace_text",
    {
      title: "Find and replace in Google Doc",
      description: "Replace every occurrence of a string in a Google Doc. Returns how many were changed.",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        document_id: z.string(),
        find: z.string().min(1),
        replace: z.string(),
        match_case: z.boolean().default(true)
      },
      annotations: WRITE_CHANGE
    },
    guarded(relinkUrl, async ({ account, document_id, find, replace, match_case }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await docs(a).documents.batchUpdate({
        documentId: document_id,
        requestBody: {
          requests: [{ replaceAllText: { containsText: { text: find, matchCase: match_case }, replaceText: replace } }]
        }
      });
      const changed = r.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      return { account: a.label, document_id, occurrences_changed: changed };
    })
  );

  // ---------------- Sheets ----------------

  server.registerTool(
    "sheets_get_info",
    {
      title: "Get spreadsheet info",
      description: "Get a spreadsheet's title and its tabs (names, sizes). Use before reading/writing ranges.",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        spreadsheet_id: z.string()
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, spreadsheet_id }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await sheets(a).spreadsheets.get({
        spreadsheetId: spreadsheet_id,
        fields: "properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))"
      });
      return {
        account: a.label,
        title: r.data.properties?.title,
        tabs: (r.data.sheets ?? []).map((s) => ({
          name: s.properties?.title,
          id: s.properties?.sheetId,
          rows: s.properties?.gridProperties?.rowCount,
          columns: s.properties?.gridProperties?.columnCount
        })),
        link: `https://docs.google.com/spreadsheets/d/${spreadsheet_id}/edit`
      };
    })
  );

  server.registerTool(
    "sheets_read_range",
    {
      title: "Read spreadsheet range",
      description: 'Read cell values from an A1 range, e.g. "Sheet1!A1:F50" or just "Budget" for a whole tab.',
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        spreadsheet_id: z.string(),
        range: z.string(),
        formulas: z.boolean().default(false).describe("Return formulas instead of computed values")
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, spreadsheet_id, range, formulas }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await sheets(a).spreadsheets.values.get({
        spreadsheetId: spreadsheet_id,
        range,
        valueRenderOption: formulas ? "FORMULA" : "FORMATTED_VALUE"
      });
      return { account: a.label, range: r.data.range, values: r.data.values ?? [] };
    })
  );

  const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

  server.registerTool(
    "sheets_write_range",
    {
      title: "Write spreadsheet range",
      description: `Overwrite cells starting at an A1 range with a 2-D array of values (rows of cells).
Values are entered as if typed, so "=SUM(A1:A3)" becomes a formula and "11/24/2026" a date.`,
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        spreadsheet_id: z.string(),
        range: z.string(),
        values: z.array(z.array(cell))
      },
      annotations: WRITE_CHANGE
    },
    guarded(relinkUrl, async ({ account, spreadsheet_id, range, values }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await sheets(a).spreadsheets.values.update({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values }
      });
      return { account: a.label, updated_range: r.data.updatedRange, updated_cells: r.data.updatedCells };
    })
  );

  server.registerTool(
    "sheets_append_rows",
    {
      title: "Append spreadsheet rows",
      description: 'Append rows after the last row of data in a tab (range like "Sheet1" or "Sheet1!A:F").',
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        spreadsheet_id: z.string(),
        range: z.string(),
        rows: z.array(z.array(cell))
      },
      annotations: WRITE_ADD
    },
    guarded(relinkUrl, async ({ account, spreadsheet_id, range, rows }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await sheets(a).spreadsheets.values.append({
        spreadsheetId: spreadsheet_id,
        range,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rows }
      });
      return { account: a.label, updated_range: r.data.updates?.updatedRange, rows_added: r.data.updates?.updatedRows };
    })
  );

  server.registerTool(
    "sheets_create",
    {
      title: "Create spreadsheet",
      description: "Create a new Google Sheet, optionally with named tabs and a header row on the first tab.",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        title: z.string(),
        tabs: z.array(z.string()).default([]),
        header_row: z.array(z.string()).default([])
      },
      annotations: WRITE_ADD
    },
    guarded(relinkUrl, async ({ account, title, tabs, header_row }) => {
      const a = await accounts.resolveOneGoogle(account);
      const sh = sheets(a);
      const r = await sh.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: tabs.length ? tabs.map((t) => ({ properties: { title: t } })) : undefined
        }
      });
      const id = r.data.spreadsheetId!;
      if (header_row.length) {
        const first = r.data.sheets?.[0]?.properties?.title ?? "Sheet1";
        await sh.spreadsheets.values.update({
          spreadsheetId: id,
          range: `'${first.replace(/'/g, "''")}'!A1`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [header_row] }
        });
      }
      return { account: a.label, spreadsheet_id: id, title, link: `https://docs.google.com/spreadsheets/d/${id}/edit` };
    })
  );
}
