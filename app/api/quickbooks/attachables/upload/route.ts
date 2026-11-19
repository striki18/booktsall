import { NextResponse } from 'next/server';

/**
 * QuickBooks attachment writes are intentionally disabled for the pilot.
 * Supporting documents are collected in Booktsall; users may attach files in QBO themselves.
 */
export async function POST() {
  return NextResponse.json(
    { error: 'QuickBooks attachment uploads are disabled in this version' },
    { status: 403 }
  );
}