import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireOrganization } from '../../platform/authentication/authenticate.js';
import { asyncHandler } from '../../platform/http/async-handler.js';
import { parseQuery } from '../../platform/http/validate.js';
import { queryMany } from '../../infrastructure/database/pool.js';

/**
 * Platform-wide search across domains, backed by PostgreSQL full text
 * (CLAUDE.md §13). A dedicated search engine is deliberately not introduced
 * yet; when it is, this route keeps its contract and only the source changes.
 */
export const searchRoutes = Router();

searchRoutes.use(authenticate());

const searchQuery = z.object({
  q: z.string().trim().min(1, 'Enter something to search for'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  types: z
    .string()
    .default('file,mail')
    .transform((value) => value.split(',').map((entry) => entry.trim())),
});

export interface SearchHit {
  id: string;
  type: 'file' | 'mail';
  title: string;
  subtitle: string;
  updatedAt: string;
  rank: number;
}

searchRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { user, organizationId } = requireOrganization(req);
    const query = parseQuery(searchQuery, req);

    const [files, mail] = await Promise.all([
      query.types.includes('file')
        ? queryMany<SearchHit>(
            `SELECT id,
                    'file'::text AS type,
                    name         AS title,
                    mime_type    AS subtitle,
                    updated_at   AS "updatedAt",
                    ts_rank(search_vector, websearch_to_tsquery('english', $3)) AS rank
               FROM files
              WHERE organization_id = $1
                AND owner_id = $2
                AND deleted_at IS NULL
                AND (search_vector @@ websearch_to_tsquery('english', $3) OR name ILIKE '%' || $3 || '%')
              ORDER BY rank DESC, updated_at DESC
              LIMIT $4`,
            [organizationId, user.id, query.q, query.limit],
          )
        : Promise.resolve([]),
      query.types.includes('mail')
        ? queryMany<SearchHit>(
            `SELECT id,
                    'mail'::text AS type,
                    subject      AS title,
                    from_address AS subtitle,
                    sent_at      AS "updatedAt",
                    ts_rank(search_vector, websearch_to_tsquery('english', $2)) AS rank
               FROM emails
              WHERE user_id = $1
                AND search_vector @@ websearch_to_tsquery('english', $2)
              ORDER BY rank DESC, sent_at DESC
              LIMIT $3`,
            [user.id, query.q, query.limit],
          )
        : Promise.resolve([]),
    ]);

    const results = [...files, ...mail].sort((a, b) => b.rank - a.rank).slice(0, query.limit);

    res.json({ query: query.q, results, counts: { files: files.length, mail: mail.length } });
  }),
);
