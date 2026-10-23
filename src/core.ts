/** Per-call options. */
export interface RequestOptions {
  /** Reuse a key to make your own retries safe; by default every write gets a fresh one. */
  idempotencyKey?: string;
  /** Milliseconds; overrides the client's timeout. */
  timeout?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  pathParams?: Record<string, string | number>;
  query?: object;
  body?: unknown;
  paged?: boolean;
}

/** What the generated resources call; implemented by BNShortener. */
export interface Requester {
  request<T = any>(spec: RequestSpec, options?: RequestOptions): Promise<T>;
  stream(spec: RequestSpec, options?: RequestOptions): AsyncIterable<StreamEvent>;
}

export interface Pagination {
  page?: number;
  per_page?: number;
  total_items?: number;
  total_pages?: number;
  has_next?: boolean;
  has_prev?: boolean;
}

/** One page of a list. Iterate it for the items, or use `bn.paginate(...)` to walk every page. */
export class Page<T> implements Iterable<T> {
  readonly pagination: Pagination;

  constructor(
    readonly data: T[],
    readonly meta: Record<string, any>,
    private readonly fetchPage: (page: number) => Promise<Page<T>>,
  ) {
    this.pagination = (meta && meta.pagination) || {};
  }

  get hasNext(): boolean {
    const p = this.pagination;
    if (p.has_next !== undefined) return Boolean(p.has_next);
    return Boolean(p.total_pages && (p.page ?? 1) < p.total_pages);
  }

  /** The following page, or null after the last one. */
  async nextPage(): Promise<Page<T> | null> {
    if (!this.hasNext) return null;
    return this.fetchPage((this.pagination.page ?? 1) + 1);
  }

  [Symbol.iterator](): Iterator<T> {
    return this.data[Symbol.iterator]();
  }
}

/** A file answer (QR code image, CSV export). */
export interface BinaryResult {
  contentType: string;
  filename?: string;
  data: Uint8Array;
  headers: Headers;
  /** The body as text (svg, eps, csv). */
  text(): string;
}

/** One server-sent event of a live stream (heartbeats are skipped). */
export interface StreamEvent {
  type?: string;
  event?: string;
  [key: string]: any;
}
