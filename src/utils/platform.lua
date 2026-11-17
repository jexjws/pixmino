-- Copyright (C) 2026 Sennoma-Nn
-- SPDX-License-Identifier: GPL-3.0-or-later

-- love.js reports Web instead of exposing native LuaJIT/FFI facilities.
return {
    is_web = love._os == "Web",
}
