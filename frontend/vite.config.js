import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The local backend defaults to HTTPS on port 4100 with a self-signed cert.
      "/api": {
        target: "https://localhost:4100",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
