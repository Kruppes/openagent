declare module 'express' {
  import type * as express from 'express-serve-static-core'
  import type { RequestHandler, ErrorRequestHandler } from 'express-serve-static-core'
  import type { Options as ServeStaticOptions } from 'serve-static'

  interface ExpressExport {
    (): express.Express
    Router(options?: express.RouterOptions): express.Router
    json: () => RequestHandler
    static(root: string, options?: ServeStaticOptions): RequestHandler
  }

  const e: ExpressExport
  export default e
  export type Router = express.Router
  export type Request = express.Request
  export type Response = express.Response
  export type NextFunction = express.NextFunction
  export type RequestHandler = RequestHandler
  export type ErrorRequestHandler = ErrorRequestHandler
  export type Express = express.Express
}

declare namespace Express {
  namespace Multer {
    interface File {
      buffer: Buffer
    }
  }
}
