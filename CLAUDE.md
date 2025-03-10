# CLAUDE.md - Development Guide

## Build Commands
- **Frontend**: `cd frontend && npm run dev` - Start the frontend development server
- **Frontend**: `cd frontend && npm run build` - Build the frontend for production
- **Solidity**: `forge build` - Build Solidity contracts
- **Solidity**: `forge test` - Run all tests
- **Solidity**: `forge test --match-test testName` - Run a specific test
- **Solidity**: `forge test --match-contract ContractName` - Run tests for a specific contract
- **Solidity**: `forge test --watch` - Run tests in watch mode

## Code Style Guidelines
- **Imports**: Group imports by type (external libs first, then local modules)
- **Formatting**: 
  - Solidity: Use 4-space indentation
  - Frontend: Use 2-space indentation, semicolons at line ends
- **Naming**: 
  - camelCase for variables/functions
  - PascalCase for components/classes/contracts
- **Types**: Use explicit types, avoid 'any' in TypeScript
- **Error Handling**: Use try/catch blocks with descriptive error messages
- **Comments**: Use JSDoc/NatSpec style for function documentation

## Architecture Notes
- Frontend uses vanilla JS with Viem for web3 functionality
- Web3-onboard for wallet connections
- Solidity contracts use Forge/Foundry for testing
- SLOW uses ERC1155 token standard