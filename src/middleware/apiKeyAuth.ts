import type { Request, Response, NextFunction } from "express";

declare global {
  namespace Express {
    interface Request {
      callerName?: string;
    }
  }
}

function loadKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [envName, value] of Object.entries(process.env)) {
    if (!envName.startsWith("API_KEY_") || !value) continue;
    const callerName = envName.slice("API_KEY_".length).toLowerCase();
    keys.set(value, callerName);
  }
  return keys;
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization: Bearer <key> header" });
  }

  const keys = loadKeys();
  const callerName = keys.get(token);
  if (!callerName) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  req.callerName = callerName;
  next();
}
