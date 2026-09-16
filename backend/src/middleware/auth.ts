import { Response, NextFunction } from 'express';
import { auth } from '../config/firebase';
import { AuthRequest } from '../types';

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = await auth.verifyIdToken(token);

    req.user = {
      id: decoded.uid,
      email: decoded.email ?? '',
      name: decoded.name,
      picture: decoded.picture,
      email_verified: decoded.email_verified ?? false,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
