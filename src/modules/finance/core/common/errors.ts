/**
 * HTTP errors thrown by the domain services. The router turns them into JSON responses of the form
 * `{ statusCode, message, errors? }`.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export class BadRequestException extends HttpError {
  constructor(message = 'Bad request', details?: { path: string; message: string }[]) {
    super(400, message, details);
  }
}

export class UnauthorizedException extends HttpError {
  constructor(message = 'Authentication required') {
    super(401, message);
  }
}

export class ForbiddenException extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

export class NotFoundException extends HttpError {
  constructor(message = 'Not found') {
    super(404, message);
  }
}

export class ConflictException extends HttpError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}

export class TooManyRequestsException extends HttpError {
  constructor(message = 'Too many requests; try again shortly') {
    super(429, message);
  }
}
