// netlify/functions/auth.mts
// POST /api/auth  { action: "signup"|"login"|"logout"|"me", username, password }

import type { Context, Config } from "@netlify/functions";
import {
  usersStore, hashPassword, verifyPassword,
  createSession, resolveSession, destroySession, jsonResponse,
} from "./_shared.mts";

interface UserRecord {
  username: string;
  passwordHash: string;
  createdAt: number;
}

function normalizeUsername(raw: string): string {
  return (raw || "").trim().toLowerCase();
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
  }

  const action = body.action;
  const store = usersStore();

  if (action === "signup") {
    const username = normalizeUsername(body.username);
    const password: string = body.password || "";
    if (!username || username.length < 3 || username.length > 24) {
      return jsonResponse({ error: "Username must be 3-24 characters." }, { status: 400 });
    }
    if (!/^[a-z0-9_]+$/.test(username)) {
      return jsonResponse({ error: "Username can only contain letters, numbers, and underscores." }, { status: 400 });
    }
    if (!password || password.length < 4) {
      return jsonResponse({ error: "Password must be at least 4 characters." }, { status: 400 });
    }
    const existing = await store.get(username, { type: "json" });
    if (existing) {
      return jsonResponse({ error: "That username is already taken." }, { status: 409 });
    }
    const record: UserRecord = {
      username,
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
    };
    await store.setJSON(username, record);
    const token = await createSession(username);
    return jsonResponse({ ok: true, username, token });
  }

  if (action === "login") {
    const username = normalizeUsername(body.username);
    const password: string = body.password || "";
    const record = await store.get(username, { type: "json" }) as UserRecord | null;
    if (!record || !verifyPassword(password, record.passwordHash)) {
      return jsonResponse({ error: "Incorrect username or password." }, { status: 401 });
    }
    const token = await createSession(username);
    return jsonResponse({ ok: true, username, token });
  }

  if (action === "logout") {
    await destroySession(req);
    return jsonResponse({ ok: true });
  }

  if (action === "me") {
    const username = await resolveSession(req);
    if (!username) {
      return jsonResponse({ error: "Not signed in." }, { status: 401 });
    }
    return jsonResponse({ ok: true, username });
  }

  return jsonResponse({ error: "Unknown action." }, { status: 400 });
};

export const config: Config = {
  path: "/api/auth",
};
