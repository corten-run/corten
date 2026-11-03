// Where items come from. ITEM_SOURCE=fixture: the item API's responses from FIXTURE_PATH,
// converted once at start, so the benchmark measures the web server alone. Otherwise every
// request fetches the item from the item API at API_BASE.
#pragma once

#include "model.h"

#include <functional>
#include <string>
#include <vector>

namespace items
{
// Reads the fixture when ITEM_SOURCE=fixture; call before the server starts.
void load();

// The items the home page shows as cards: the first 50 by id with items in memory, none from
// the item API (which cannot list items).
std::vector<ItemPtr> shelf();

// One item, or null when there is none; `failed` when the item API could not answer.
void get(const std::string &id, std::function<void(ItemPtr item, bool failed)> done);
}  // namespace items
