import { google, type calendar_v3 } from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Accounts, GoogleAccount } from "../accounts.js";
import { ACCOUNT_DESC, ACCOUNT_OR_ALL_DESC, READ, WRITE_ADD, WRITE_CHANGE, fanOut, guarded } from "./common.js";

// ============================================================
// Google Calendar — list/read, create, update. No delete tool.
// Invitations are NOT emailed to attendees unless send_invites=true.
// ============================================================

const DEFAULT_TZ = "America/New_York";

function slim(account: GoogleAccount, e: calendar_v3.Schema$Event) {
  return {
    account: account.label,
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    all_day: Boolean(e.start?.date),
    location: e.location,
    description: e.description?.slice(0, 2000),
    organizer: e.organizer?.email,
    attendees: e.attendees?.map((a) => ({ email: a.email, name: a.displayName, response: a.responseStatus })),
    my_response: e.attendees?.find((a) => a.self)?.responseStatus,
    meet: e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri,
    status: e.status,
    link: e.htmlLink
  };
}

const timeSchema = z
  .string()
  .describe('ISO 8601 date-time like "2026-11-24T15:00:00" (interpreted in time_zone) or a date "2026-11-24" for all-day');

function toEventTime(value: string, tz: string): calendar_v3.Schema$EventDateTime {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value, timeZone: tz };
}

export function registerCalendarTools(server: McpServer, accounts: Accounts, relinkUrl: string) {
  const cal = (a: GoogleAccount) => google.calendar({ version: "v3", auth: accounts.googleAuth(a) });

  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List calendars",
      description: "List the calendars each account can see (own, shared, subscribed), with their IDs.",
      inputSchema: { account: z.string().default("all").describe(ACCOUNT_OR_ALL_DESC) },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account }) => {
      const targets = await accounts.resolveGoogle(account, true);
      const { results, failed } = await fanOut(
        targets,
        (a) => a.label,
        async (a) => {
          const r = await cal(a).calendarList.list({ maxResults: 250 });
          return (r.data.items ?? []).map((c) => ({
            id: c.id,
            name: c.summaryOverride ?? c.summary,
            primary: c.primary ?? false,
            access: c.accessRole,
            time_zone: c.timeZone
          }));
        },
        relinkUrl
      );
      return { calendars: results.map((r) => ({ account: r.account, calendars: r.value })), accounts_failed: failed };
    })
  );

  server.registerTool(
    "calendar_list_events",
    {
      title: "List calendar events",
      description: `List events in a time window across one or all accounts, sorted by start time.
Defaults: from now to 7 days ahead, primary calendar. Use query for free-text matching (title, description, attendees).`,
      inputSchema: {
        account: z.string().default("all").describe(ACCOUNT_OR_ALL_DESC),
        time_min: z.string().optional().describe("ISO 8601 with offset, e.g. 2026-11-24T00:00:00-05:00. Default: now"),
        time_max: z.string().optional().describe("ISO 8601 with offset. Default: time_min + 7 days"),
        query: z.string().optional(),
        calendar_id: z.string().default("primary"),
        max_results: z.number().int().min(1).max(250).default(50).describe("Per account")
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, time_min, time_max, query, calendar_id, max_results }) => {
      const targets = await accounts.resolveGoogle(account, true);
      const min = time_min ? new Date(time_min) : new Date();
      const max = time_max ? new Date(time_max) : new Date(min.getTime() + 7 * 86400000);
      const { results, failed } = await fanOut(
        targets,
        (a) => a.label,
        async (a) => {
          const r = await cal(a).events.list({
            calendarId: calendar_id,
            timeMin: min.toISOString(),
            timeMax: max.toISOString(),
            q: query,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: max_results
          });
          return (r.data.items ?? []).map((e) => slim(a, e));
        },
        relinkUrl
      );
      const events = results
        .flatMap((r) => r.value)
        .sort((x, y) => String(x.start).localeCompare(String(y.start)));
      return { window: { from: min.toISOString(), to: max.toISOString() }, accounts_failed: failed, events };
    })
  );

  server.registerTool(
    "calendar_get_event",
    {
      title: "Get calendar event",
      description: "Get one event's full details.",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        event_id: z.string(),
        calendar_id: z.string().default("primary")
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, event_id, calendar_id }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await cal(a).events.get({ calendarId: calendar_id, eventId: event_id });
      return { ...slim(a, r.data), description: r.data.description };
    })
  );

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create calendar event",
      description: `Create an event. By default attendees are added WITHOUT being emailed an invitation;
set send_invites=true only when the owner has explicitly asked for invites to go out.`,
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        summary: z.string(),
        start: timeSchema,
        end: timeSchema,
        time_zone: z.string().default(DEFAULT_TZ),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z.array(z.string()).default([]).describe("Attendee email addresses"),
        add_google_meet: z.boolean().default(false),
        send_invites: z.boolean().default(false),
        calendar_id: z.string().default("primary")
      },
      annotations: WRITE_ADD
    },
    guarded(relinkUrl, async (args) => {
      const a = await accounts.resolveOneGoogle(args.account);
      const r = await cal(a).events.insert({
        calendarId: args.calendar_id,
        sendUpdates: args.send_invites ? "all" : "none",
        conferenceDataVersion: args.add_google_meet ? 1 : undefined,
        requestBody: {
          summary: args.summary,
          description: args.description,
          location: args.location,
          start: toEventTime(args.start, args.time_zone),
          end: toEventTime(args.end, args.time_zone),
          attendees: args.attendees.map((email) => ({ email })),
          conferenceData: args.add_google_meet
            ? { createRequest: { requestId: `cc-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } }
            : undefined
        }
      });
      return { created: slim(a, r.data), invites_sent: args.send_invites };
    })
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update calendar event",
      description: `Change fields on an existing event (only the fields you pass are changed).
add_attendees/remove_attendees edit the guest list. Attendees are not emailed unless send_updates=true.`,
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        event_id: z.string(),
        calendar_id: z.string().default("primary"),
        summary: z.string().optional(),
        start: timeSchema.optional(),
        end: timeSchema.optional(),
        time_zone: z.string().default(DEFAULT_TZ),
        description: z.string().optional(),
        location: z.string().optional(),
        add_attendees: z.array(z.string()).default([]),
        remove_attendees: z.array(z.string()).default([]),
        send_updates: z.boolean().default(false)
      },
      annotations: WRITE_CHANGE
    },
    guarded(relinkUrl, async (args) => {
      const a = await accounts.resolveOneGoogle(args.account);
      const c = cal(a);
      const patch: calendar_v3.Schema$Event = {};
      if (args.summary !== undefined) patch.summary = args.summary;
      if (args.description !== undefined) patch.description = args.description;
      if (args.location !== undefined) patch.location = args.location;
      if (args.start) patch.start = toEventTime(args.start, args.time_zone);
      if (args.end) patch.end = toEventTime(args.end, args.time_zone);
      if (args.add_attendees.length || args.remove_attendees.length) {
        const cur = await c.events.get({ calendarId: args.calendar_id, eventId: args.event_id });
        const remove = new Set(args.remove_attendees.map((e) => e.toLowerCase()));
        const list = (cur.data.attendees ?? []).filter((x) => !remove.has((x.email ?? "").toLowerCase()));
        for (const email of args.add_attendees) {
          if (!list.some((x) => x.email?.toLowerCase() === email.toLowerCase())) list.push({ email });
        }
        patch.attendees = list;
      }
      const r = await c.events.patch({
        calendarId: args.calendar_id,
        eventId: args.event_id,
        sendUpdates: args.send_updates ? "all" : "none",
        requestBody: patch
      });
      return { updated: slim(a, r.data), updates_sent: args.send_updates };
    })
  );
}
