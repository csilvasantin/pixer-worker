// Durable Object XpacioCupo (DCL-ddf3203078fe9471f3796130): el cupo de POST /xpacio/estimar.
// Una sola instancia global (idFromName('xpacio-estimar')) con SQLite. Los métodos RPC son
// síncronos: leer, comprobar y escribir ocurren sin ningún `await` por medio, así que la reserva es
// atómica aunque lleguen cien peticiones a la vez. La lógica está en xpacio-cupo.mjs (con tests).
import { DurableObject } from 'cloudflare:workers';
import { reservarCupo, liquidarCupo } from './xpacio-cupo.mjs';

export class XpacioCupo extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS cupo (dia TEXT NOT NULL, clave TEXT NOT NULL, n INTEGER NOT NULL, micro INTEGER NOT NULL, PRIMARY KEY (dia, clave))');
    this.almacen = {
      leer: (dia, clave) => sql.exec('SELECT n, micro FROM cupo WHERE dia = ? AND clave = ?', dia, clave).toArray()[0] || null,
      escribir: (dia, clave, f) => { sql.exec('INSERT INTO cupo (dia, clave, n, micro) VALUES (?, ?, ?, ?) ON CONFLICT(dia, clave) DO UPDATE SET n = excluded.n, micro = excluded.micro', dia, clave, f.n, f.micro); },
      purgar: diaMin => { sql.exec('DELETE FROM cupo WHERE dia < ?', diaMin); }
    };
  }
  // Comprobar y reservar en un solo paso. El reloj es el del DO, no el del que llama.
  reservar(peticion) { return reservarCupo(this.almacen, { ...peticion, ahora: Date.now() }); }
  // Coste real tras la llamada a Gemini (o 0 si no se llegó a llamar).
  liquidar(liquidacion) { return liquidarCupo(this.almacen, liquidacion); }
}
