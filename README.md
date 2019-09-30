# Compound Subgraph Wrapper

A wrapper service that extends the Compound subgraph with custom resolvers.

## Todo

- [x] Server application skeleton
- [x] Remote subgraph schema integration
- [x] Schema stitching example
- [x] Subscriptions
- [ ] Deployment w/ proxy server
- [ ] Real resolvers

## Usage

After cloning this repository, run the following to start the server process:

```sh
# Install dependencies
yarn

# Build the server 
yarn prepublish

# Run the server
node dist/index.js
```

## Development

During development, run the server with

```sh
yarn dev
```

so it automatically restarts as you make changes to the source code.
