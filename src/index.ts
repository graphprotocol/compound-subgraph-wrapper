import express, { Request, Response, NextFunction } from 'express'
import expressWs from 'express-ws'
import bodyParser from 'body-parser'
import winston from 'winston'
import expressWinston from 'express-winston'
import http from 'http'
import WebSocket from 'ws'
import BigNumber from 'bignumber.js'
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

const SUBGRAPH_QUERY_ENDPOINT = process.env.SUBGRAPH_QUERY_ENDPOINT
const SUBGRAPH_SUBSCRIPTION_ENDPOINT = process.env.SUBGRAPH_SUBSCRIPTION_ENDPOINT

if (!SUBGRAPH_QUERY_ENDPOINT) {
  throw new Error('Environment variable SUBGRAPH_QUERY_ENDPOINT is not set')
}

if (!SUBGRAPH_SUBSCRIPTION_ENDPOINT) {
  throw new Error('Environment variable SUBGRAPH_SUBSCRIPTION_ENDPOINT is not set')
}

const createQueryNodeHttpLink = () =>
  new HttpLink({
    uri: SUBGRAPH_QUERY_ENDPOINT,
    fetch: fetch as any,
  })

const createSchema = async (): Promise<GraphQLSchema> => {
  let httpLink = createQueryNodeHttpLink()
  let remoteSchema = await introspectSchema(httpLink)

  const subscriptionClient = new SubscriptionClient(
    SUBGRAPH_SUBSCRIPTION_ENDPOINT,
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
    extend type Account {
      health: BigDecimal
      totalBorrowValueInEth: BigDecimal!
      totalCollateralValueInEth: BigDecimal!
    }

    extend type AccountCToken {
      supplyBalanceUnderlying: BigDecimal!
      lifetimeSupplyInterestAccrued: BigDecimal!
      borrowBalanceUnderlying: BigDecimal!
      lifetimeBorrowInterestAccrued: BigDecimal!
    }
  `

  const bignum = (value: string) => new BigNumber(value)

  const supplyBalanceUnderlying = (cToken: any): BigNumber =>
    bignum(cToken.cTokenBalance).times(cToken.market.exchangeRate)

  const borrowBalanceUnderlying = (cToken: any): BigNumber =>
    bignum(cToken.accountBorrowIndex).eq(bignum('0'))
      ? bignum('0')
      : bignum(cToken.storedBorrowBalance)
          .times(cToken.market.borrowIndex)
          .dividedBy(cToken.accountBorrowIndex)

  const tokenInEth = (market: any): BigNumber =>
    bignum(market.collateralFactor)
      .times(market.exchangeRate)
      .times(market.underlyingPrice)

  const totalCollateralValueInEth = (account: any): BigNumber =>
    account.___tokens.reduce(
      (acc, token) => acc.plus(tokenInEth(token.market).times(token.cTokenBalance)),
      bignum('0'),
    )

  const totalBorrowValueInEth = (account: any): BigNumber =>
    !account.hasBorrowed
      ? bignum('0')
      : account.___tokens.reduce(
          (acc, token) =>
            acc.plus(
              bignum(token.market.underlyingPrice).times(borrowBalanceUnderlying(token)),
            ),
          bignum('0'),
        )

  return mergeSchemas({
    schemas: [subgraphSchema, customSchema],
    resolvers: {
      Account: {
        health: {
          fragment: `
            ... on Account {
              id
              hasBorrowed
              ___tokens: tokens {
                cTokenBalance
                storedBorrowBalance
                accountBorrowIndex
                market {
                  borrowIndex
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
          resolve: (account, _args, _context, _info) => {
            if (!account.hasBorrowed) {
              return null
            } else {
              let totalBorrow = totalBorrowValueInEth(account)
              return totalBorrow.eq('0')
                ? totalCollateralValueInEth(account)
                : totalCollateralValueInEth(account).dividedBy(totalBorrow)
            }
          },
        },

        totalBorrowValueInEth: {
          fragment: `
            ... on Account {
              id
              hasBorrowed
              ___tokens: tokens {
                cTokenBalance
                storedBorrowBalance
                accountBorrowIndex
                market {
                  borrowIndex
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
          resolve: (account, _args, _context, _info) => totalBorrowValueInEth(account),
        },

        totalCollateralValueInEth: {
          fragment: `
            ... on Account {
              id
              ___tokens: tokens {
                cTokenBalance
                market {
                  collateralFactor
                  exchangeRate
                  underlyingPrice
                }
              }
            }
          `,
          resolve: (account, _args, _context, _info) =>
            totalCollateralValueInEth(account),
        },
      },

      AccountCToken: {
        supplyBalanceUnderlying: {
          fragment: `... on AccountCToken { id cTokenBalance market { exchangeRate } }`,
          resolve: (cToken, _args, _context, _info) => supplyBalanceUnderlying(cToken),
        },

        lifetimeSupplyInterestAccrued: {
          fragment: `
            ... on AccountCToken {
              id
              cTokenBalance
              market { exchangeRate }
              totalUnderlyingSupplied
              totalUnderlyingRedeemed
            }
          `,
          resolve: (cToken, _args, _context, _info) =>
            supplyBalanceUnderlying(cToken)
              .minus(cToken.totalUnderlyingSupplied)
              .plus(cToken.totalUnderlyingRedeemed),
        },

        borrowBalanceUnderlying: {
          fragment: `
            ... on AccountCToken {
              id
              storedBorrowBalance
              accountBorrowIndex
              market { borrowIndex }
            }
          `,
          resolve: (cToken, _args, _context, _info) => borrowBalanceUnderlying(cToken),
        },

        lifetimeBorrowInterestAccrued: {
          fragment: `
            ... on AccountCToken {
              id
              storedBorrowBalance
              accountBorrowIndex
              market { borrowIndex }
              totalUnderlyingBorrowed
              totalUnderlyingRepaid
            }
          `,
          resolve: (cToken, _args, _context, _info) =>
            borrowBalanceUnderlying(cToken)
              .minus(cToken.totalUnderlyingBorrowed)
              .plus(cToken.totalUnderlyingRepaid),
        },
      },
    },
  })
}

/**
 * Server application
 */

// Define the middleware
const rejectBadHeaders = async (req: Request, res: Response, next: NextFunction) => {
  if (
    req.headers['challenge-bypass-token'] ||
    req.headers['x_proxy_id']
    // Note: This one doesn't work on Google Cloud:
    // req.headers["via"]
  ) {
    return res.status(400).send('Bad Request')
  } else {
    next()
  }
}

const run = async () => {
  logger.info(`Create application`)
  const { app } = expressWs(express())
  app.use(rejectBadHeaders)
  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: true }))
  app.use(
    expressWinston.logger({
      level: 'debug',
      transports: [loggerTransport],
      baseMeta: { component: 'Server' },
    }),
  )
  app.use(
    expressWinston.errorLogger({
      transports: [loggerTransport],
      baseMeta: { component: 'Server' },
    }),
  )

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
