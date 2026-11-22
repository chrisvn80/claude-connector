import { Firestore, Timestamp } from "@google-cloud/firestore";

// ============================================================
// Key-value store with optional expiry. Firestore in production,
// in-memory for local testing.
// ============================================================

export interface Store {
  get<T>(collection: string, id: string): Promise<T | undefined>;
  set<T>(collection: string, id: string, data: T, ttlSec?: number): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  /** Atomically read and delete (single-use values like auth codes). */
  take<T>(collection: string, id: string): Promise<T | undefined>;
  list<T>(collection: string): Promise<Array<{ id: string; data: T }>>;
}

const PREFIX = "cc_";

export class FirestoreStore implements Store {
  private db = new Firestore({ ignoreUndefinedProperties: true });

  private ref(collection: string, id: string) {
    return this.db.collection(PREFIX + collection).doc(id);
  }

  private static live(doc: FirebaseFirestore.DocumentData | undefined): boolean {
    if (!doc) return false;
    const exp = doc.expiresAt as Timestamp | undefined;
    return !exp || exp.toMillis() > Date.now();
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    const snap = await this.ref(collection, id).get();
    const doc = snap.data();
    return FirestoreStore.live(doc) ? (JSON.parse(doc!.json) as T) : undefined;
  }

  async set<T>(collection: string, id: string, data: T, ttlSec?: number): Promise<void> {
    await this.ref(collection, id).set({
      json: JSON.stringify(data),
      updatedAt: Timestamp.now(),
      expiresAt: ttlSec ? Timestamp.fromMillis(Date.now() + ttlSec * 1000) : undefined
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.ref(collection, id).delete();
  }

  async take<T>(collection: string, id: string): Promise<T | undefined> {
    const ref = this.ref(collection, id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const doc = snap.data();
      if (!snap.exists) return undefined;
      tx.delete(ref);
      return FirestoreStore.live(doc) ? (JSON.parse(doc!.json) as T) : undefined;
    });
  }

  async list<T>(collection: string): Promise<Array<{ id: string; data: T }>> {
    const snap = await this.db.collection(PREFIX + collection).get();
    return snap.docs
      .filter((d) => FirestoreStore.live(d.data()))
      .map((d) => ({ id: d.id, data: JSON.parse(d.data().json) as T }));
  }
}

export class MemoryStore implements Store {
  private data = new Map<string, { json: string; expiresAt?: number }>();

  private key(c: string, id: string) {
    return `${c}/${id}`;
  }

  private read<T>(k: string): T | undefined {
    const v = this.data.get(k);
    if (!v) return undefined;
    if (v.expiresAt && v.expiresAt <= Date.now()) {
      this.data.delete(k);
      return undefined;
    }
    return JSON.parse(v.json) as T;
  }

  async get<T>(c: string, id: string) {
    return this.read<T>(this.key(c, id));
  }
  async set<T>(c: string, id: string, d: T, ttlSec?: number) {
    this.data.set(this.key(c, id), {
      json: JSON.stringify(d),
      expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : undefined
    });
  }
  async delete(c: string, id: string) {
    this.data.delete(this.key(c, id));
  }
  async take<T>(c: string, id: string) {
    const v = this.read<T>(this.key(c, id));
    this.data.delete(this.key(c, id));
    return v;
  }
  async list<T>(c: string) {
    const out: Array<{ id: string; data: T }> = [];
    for (const k of [...this.data.keys()]) {
      if (!k.startsWith(c + "/")) continue;
      const v = this.read<T>(k);
      if (v !== undefined) out.push({ id: k.slice(c.length + 1), data: v });
    }
    return out;
  }
}
