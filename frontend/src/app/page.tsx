// The Plemmo merchant UI is now Meridian (served by the embedded server at the
// app root). This Next.js app remains only for the KDS station (/kds-standalone)
// and the server display (/server-standalone). The former merchant dashboard,
// auth and setup routes were retired — the embedded server serves Meridian and,
// as a fallback (PLEMMO_MERIDIAN_UI=0), this page.
export default function Home() {
  return null;
}
