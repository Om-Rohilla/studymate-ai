import { defineConfig } from 'vite'

// https://vite.dev/config/
// StudyMate AI — Multi-page HTML app (no React framework, pure HTML/JS/CSS)
export default defineConfig({
  // Root is the frontend/ folder
  root: '.',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Multi-page app: each HTML file is an entry point
    rollupOptions: {
      input: {
        main:        'index.html',
        login:       'login.html',
        tutor:       'tutor.html',
        notes:       'notes.html',
        quiz:        'quiz.html',
        flashcards:  'flashcards.html',
        planner:     'planner.html',
        about:       'about.html',
        contact:     'contact.html',
        '404':       '404.html',
      },
    },
    // Increase chunk size warning limit for large pages
    chunkSizeWarningLimit: 1000,
  },

  // Resolve bare module imports from db.js, supabase-client.js etc.
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
  },

  server: {
    port: 5173,
    open: 'index.html',
  },
})
