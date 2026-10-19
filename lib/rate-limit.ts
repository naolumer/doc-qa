import { prisma } from "./prisma";

export type LimitResult = { allowed: boolean; count: number };

/** Counts this request in the current window and says whether it is still within the limit. */
export async function hit(key: string, limit: number, windowSeconds: number): Promise<LimitResult> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count")
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"
  `;
  const count = Number(rows[0]?.count ?? 1);

  // Occasionally remove old windows so the table stays small.
  if (Math.random() < 0.01) {
    prisma.$executeRaw`DELETE FROM "RateLimit" WHERE "windowStart" < now() - interval '2 days'`.catch(() => {});
  }

  return { allowed: count <= limit, count };
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "local";
}