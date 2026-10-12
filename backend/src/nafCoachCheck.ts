const COACH_CHECK_URL = 'https://www.thenaf.net/coachcheck.php';
// Generous (the NAF site can be slow) but still under the Lambda's own 30s timeout.
const COACH_CHECK_TIMEOUT_MS = 20000;

export type NafCoachLookup = { status: 'found'; nafName: string } | { status: 'not_found' } | { status: 'unavailable' };

/**
 * Looks up the coach name the NAF has on file for a NAF number. 'unavailable' covers every way
 * the NAF site can fail us (down, slow, unexpected payload) — callers let the edit through in that
 * case rather than blocking coaches on a third-party outage.
 */
export async function lookupNafCoach(nafNumber: string): Promise<NafCoachLookup> {
  try {
    const res = await fetch(`${COACH_CHECK_URL}?naf_id=${encodeURIComponent(nafNumber)}`, {
      signal: AbortSignal.timeout(COACH_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'unavailable' };
    const body = (await res.json()) as { naf_name?: unknown; error?: unknown };
    if (typeof body.naf_name === 'string' && body.naf_name.trim()) return { status: 'found', nafName: body.naf_name.trim() };
    // The NAF answers an unknown number with 200 + {"error":"No data found for this NAF ID"}.
    if (typeof body.error === 'string') return { status: 'not_found' };
    return { status: 'unavailable' };
  } catch (err) {
    console.warn('NAF coach check failed', err);
    return { status: 'unavailable' };
  }
}
