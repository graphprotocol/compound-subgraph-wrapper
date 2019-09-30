import express from 'express'
import expressWs from 'express-ws'
import bodyParser from 'body-parser'
import winston from 'winston'
import http from 'http'
import WebSocket from 'ws'
import { SubscriptionClient } from 'subscriptions-transport-ws'
import { ApolloServer } from 'apollo-server-express'
import { split } from 'apollo-link'
import { HttpLink } from 'apollo-link-http'
import { WebSocketLink } from 'apollo-link-ws'
import { fetch } from 'apollo-env'
import { getMainDefinition } from 'apollo-utilities'
import { GraphQLSchema } from 'graphql'
import {
  introspectSchema,
  makeExecutableSchema,
  makeRemoteExecutableSchema,
  mergeSchemas,
} from 'graphql-tools'

/**
 * Logging
 */

let loggerColorizer = winston.format.colorize()
let loggerTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.timestamp(),
    loggerColorizer,
    winston.format.ms(),
    winston.format.printf(args => {
      let { level, message, component, timestamp, ms } = args
      return `${timestamp} ${level} ${component} → ${message} ${loggerColorizer.colorize(
        'debug',
        ms,
      )}`
    }),
  ),
})
let logger = winston
  .createLogger({
    level: 'debug',
    transports: [loggerTransport],
  })
  .child({ component: 'App' })

/**
 * GraphQL context
 */

interface GraphQLContext {
  logger: winston.Logger
}

/**
 * GraphQL schema
 */

const createQueryNodeHttpLink = () =>
  new HttpLink({
    uri: 'https://api.thegraph.com/subgraphs/name/compound-finance/compound-v2',
    fetch: fetch as any,
  })

const createSchema = async (): Promise<GraphQLSchema> => {
  let httpLink = createQueryNodeHttpLink()
  let remoteSchema = await introspectSchema(httpLink)

  const subscriptionClient = new SubscriptionClient(
    'wss://api.thegraph.com/subgraphs/name/compound-finance/compound-v2',
    {
      reconnect: true,
    },
    WebSocket,
  )

  const wsLink = new WebSocketLink(subscriptionClient)
  const link = split(
    ({ query }) => {
      const { kind, operation } = getMainDefinition(query) as any
      return kind === 'OperationDefinition' && operation === 'subscription'
    },
    wsLink,
    httpLink,
  )

  let subgraphSchema = makeRemoteExecutableSchema({
    schema: remoteSchema,
    link,
  })

  let customSchema = `
    extend type User {
      customField: String!
    }
  `

  return mergeSchemas({
    schemas: [subgraphSchema, customSchema],
    resolvers: {
      User: {
        customField: {
          fragment: `... on User { id }`,
          resolve: (user, args, context, info) => {
            return 'customValue'
          },
        },
      },
    },
  })
}

/**
 * GraphQL resolvers
 */

/**
 * Server application
 */

const run = async () => {
  logger.info(`Create application`)
  const { app } = expressWs(express())
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: true }))

  logger.info(`Create Apollo server`)
  const apolloServer = new ApolloServer({
    subscriptions: {
      path: '/',
    },
    schema: await createSchema(),
    introspection: true,
    playground: true,
    context: async ({ req }: any): Promise<GraphQLContext> => {
      return {
        logger: logger.child({ component: 'ApolloServer' }),
      }
    },
  })

  logger.info(`Install GraphQL request handlers`)
  apolloServer.applyMiddleware({
    app,
    path: '/',
    cors: {
      origin: '*',
    },
  })

  logger.info(`Create HTTP server`)
  const server = http.createServer(app)

  logger.info(`Install GraphQL subscription handlers`)
  apolloServer.installSubscriptionHandlers(server)

  logger.info(`Start server`)
  try {
    await server.listen(9500, () => {
      logger.info('Listening on port 9500')
    })
  } catch (e) {
    logger.error(`Server crashed:`, e)
    process.exitCode = 1
  }
}

run()
