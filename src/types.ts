export type Doc = Record<string, any>;

export interface Change {
  id: string;
  seq?: string;
  deleted?: boolean;
  doc?: any;
  changes?: any[];
}

export interface FindResult {
  docs: Doc[];
  bookmark?: string;
  warning?: string;
}

export interface ChangesResult {
  results: Change[];
  lastSeq: string;
  pending?: number;
}
