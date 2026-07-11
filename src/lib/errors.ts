// Typed application errors. Services throw these; the central error handler
// (middleware/errorHandler.ts) turns them into the right HTTP status + JSON.

export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = new.target.name;
  }
}

export class BadRequest extends AppError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

export class Unauthorized extends AppError {
  constructor(message = "Not authenticated") {
    super(401, message);
  }
}

export class Forbidden extends AppError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}

export class NotFound extends AppError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

export class Conflict extends AppError {
  constructor(message = "Conflict") {
    super(409, message);
  }
}
