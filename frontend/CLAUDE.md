# CLAUDE.md - Frontend Developer Guide

## Build Commands
- `npm run build` - Build the project for production using Vite
- `npm run dev` - Start the Vite development server with hot-reloading
- `npm run preview` - Preview the production build locally
- `npm run lint` - Run ESLint to check code style
- `npm run test` - Run frontend tests
- `npm run build:singlefile` - Generate a single HTML file with all CSS/JS inlined for IPFS deployment
- `npm run deploy:pinata` - Build single HTML file and deploy to Pinata IPFS

## Code Style Guidelines
- **Imports**: Group imports by type (external libs first, then local modules, then styles)
- **Formatting**: Use 2-space indentation, semicolons at line ends
- **Naming**: camelCase for variables/functions, PascalCase for components/classes
- **Functions**: Use arrow functions for callbacks, explicit function declarations for main functions
- **Error Handling**: Use try/catch blocks with descriptive error messages
- **Comments**: Use JSDoc style for function documentation
- **Components**: Follow atomic design principles where applicable

## Architecture Notes
- Using viem for web3 functionality
- Web3 onboard for wallet connections
- Vite for bundling and development
- Vanilla JavaScript for UI components

## IPFS Deployment
- The IPFS deployment uses vite-plugin-singlefile to generate a single HTML file
- The Vite configuration inlines all assets into a single HTML file using viteSingleFile
- Resource paths are relative (./path) instead of absolute (/path) for IPFS compatibility
- Pinata API is used for uploading to IPFS
- The deployment script uses PINATA_JWT environment variable for authentication