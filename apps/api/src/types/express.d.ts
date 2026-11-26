declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        businessId?: string;
        role?: string;
      };
    }
  }
}

export {};