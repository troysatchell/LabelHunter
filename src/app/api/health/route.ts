import { NextResponse } from "next/server";

// Minimal liveness check: proves the app process is up and routing works.
// Deliberately does not touch the database — a DB hiccup shouldn't take
// down the web process's own health signal. A DB-aware readiness check can
// be added alongside this if a later ticket needs one.
export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "labelhunter",
    timestamp: new Date().toISOString(),
  });
}
