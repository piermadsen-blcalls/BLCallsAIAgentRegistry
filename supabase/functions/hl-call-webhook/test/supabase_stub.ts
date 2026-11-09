// Stands in for jsr:@supabase/supabase-js@2 (mapped in import_map.json) and records inserts.
export const inserted: Record<string, unknown>[] = [];
export function createClient(_url: string, _key: string) {
  return {
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve({ error: null as { message: string } | null });
      },
    }),
  };
}
