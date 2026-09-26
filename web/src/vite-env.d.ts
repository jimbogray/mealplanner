/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the API, e.g. https://api.example.com. Empty means same origin (the dev proxy). */
  readonly VITE_API_URL?: string;
}
