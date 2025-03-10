# CLAUDE.md - Frontend Developer Guide

## Build Commands
- `npm run build` - Build the project for production
- `npm run dev` - Start the development server with hot-reloading
- `npm run lint` - Run ESLint to check code style
- `npm run test` - Run frontend tests

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
- Webpack for bundling
- Vanilla JavaScript for UI components