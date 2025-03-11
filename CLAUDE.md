# Magic Code Project Guidelines

## Build/Run Commands
- App: `cd app && npm run dev` - Start React app development server
- Server: `cd server && npm run dev` - Start backend server with auto-reload
- Build App: `cd app && npm run build` - Compile TypeScript and build for production
- Lint: `cd app && npm run lint` - Run ESLint on all TypeScript/TSX files
- Preview: `cd app && npm run preview` - Preview production build locally

## TypeScript/Code Style Guidelines
- Use TypeScript's strict mode with explicit typing
- React function components with explicit return types
- Import order: React, external libs, internal modules, CSS
- Use interfaces for object types over type aliases
- Use arrow functions for React component props/callbacks
- Prefer const over let; avoid var
- Use async/await over raw promises
- Use optional chaining and nullish coalescing
- Implement proper error handling with try/catch blocks
- Handle null/undefined values explicitly
