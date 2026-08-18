export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request') => new AppError(400, code, message);
export const unauthorized = (message = 'Invalid or missing token', code = 'unauthorized') =>
  new AppError(401, code, message);
export const forbidden = (message: string, code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message: string, code = 'not_found') => new AppError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
