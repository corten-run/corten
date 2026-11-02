import { shelf } from "#lib/server/api";
import type { PageServerLoad } from "./$types";

// Corten's home page: cards with items in memory, links by id from the item API.
export const load: PageServerLoad = () => ({ cards: shelf() });
