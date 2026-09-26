/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API, e.g. https://api.example.com. Empty means same origin (the dev proxy). */
  readonly VITE_API_URL?: string;
  /** OAuth client id for Sign in with Google (same as the API's GOOGLE_CLIENT_ID). Unset hides the Google button. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
