-- Run from the repository root with lua5.1 or luajit tests/web-compat.lua.
local function check(value, message)
    assert(value, message)
end

local utils = require("src.utils.utils")
check(utils.get_value_if_func_call("ENGLISH") == "ENGLISH", "literal menu text survives Lua 5.1 varargs")
local color = { 1, 0.5, 0 }
check(utils.get_value_if_func_call(function() return color end) == color, "piece color callback returns a table")
check(utils.get_value_if_func_call(function(a, b) return a + b end, 2, 3) == 5, "callback arguments forwarded")
local resolved = utils.resolve_deep({ literal = "block", nested = { fn = function(v) return v * 2 end } }, 3)
check(resolved.literal == "block" and resolved.nested.fn == 6, "mode overrides resolve under Lua 5.1")

love = { _os = "Web" }
local platform = require("src.utils.platform")
check(platform.is_web, "Web platform detection")

-- A Web build must never load nativefs, even when stale settings enable scripts.
package.preload["lib.nativefs"] = function() error("nativefs must not load on Web") end
for _, name in ipairs({ "game", "draw" }) do package.loaded["src.game." .. name] = {} end
package.loaded["src.menu.menu"] = {}
package.loaded["src.utils.save"] = {}
local settings = {
    sound = { volume = { bgm = 0.4, sfx = 1 } },
    input = { keys = { left = "left" } },
    display = { locale = "en", fullscreen = false, skin = "block" },
    debug = {}, game = { allow_user_script = false },
}
Settings = settings
package.loaded["src.menu.settings"] = settings
package.loaded["src.manager.locale"] = { langs = { "en", "zh_cn" }, current = "en" }
local scripts = require("user_script")
check(scripts.config_dir() == nil, "no native configuration path on Web")
scripts.run()
check(next(scripts.get_custom_skins()) == nil, "no native skins on Web")
check(next(scripts.get_custom_i18n()) == nil, "no native languages on Web")
check(next(scripts.get_custom_modes()) == nil, "no native modes on Web")
check(package.loaded["lib.nativefs"] == nil, "nativefs was not loaded")

-- Check decoded glyph pixels against independently generated binary strings.
bit = nil
jit = nil
local bytes = {}
for value = 0, 255 do bytes[#bytes + 1] = string.char(value) end
love.filesystem = { read = function() return table.concat(bytes) end }
love.image = { newImageData = function(w, h)
    return { pixels = {}, setPixel = function(self, x, y)
        self.pixels[y * w + x] = true
    end }
end }
love.graphics = {
    newImage = function(data) data.setFilter = function() end; return data end,
    newQuad = function() return {} end,
}
local font = require("lib.vgafont").load("test")
for value = 0, 255 do
    local binary, n = "", value
    for _ = 1, 8 do
        binary = tostring(n % 2) .. binary
        n = math.floor(n / 2)
    end
    for x = 0, 7 do
        local index = math.floor(value / 16) * 128 + value % 16 * 8 + x
        check(not not font.image.pixels[index] == (binary:sub(x + 1, x + 1) == "1"),
            "glyph bit mismatch: " .. value .. ":" .. x)
    end
end

-- Exercise real serialization, optional reads, debouncing, failures and reload.
local files, writes, fail_write = {}, 0, false
love.filesystem = {
    getInfo = function(path) return files[path] and { type = "file" } end,
    read = function(path) assert(files[path], "missing files must not be read"); return files[path] end,
    write = function(path, text)
        if fail_write then return false, "test storage failure" end
        files[path], writes = text, writes + 1
        return true
    end,
}
package.loaded["src.manager.sfx"] = { set_bgm_volume = function() end, set_sfx_volume = function() end }
package.loaded["src.manager.skin"] = { get_list = function() return { "block" } end }
package.loaded["src.utils.save"] = nil
local save = require("src.utils.save")
local json = require("lib.json")
local fullscreen, has_locale = save.load()
check(not fullscreen and not has_locale, "first boot defaults")
settings.display.locale = "zh_cn"
save.request_flush()
save.update(0.1)
check(writes == 0, "debounce waits")
save.request_flush()
save.update(0.2)
check(writes == 1, "repeated keys cannot starve the pending save")
check(json.decode(files["settings.json"]).display.locale == "zh_cn", "language serialized")
save.flush()
check(writes == 1, "unchanged settings do not rewrite storage")
save.update_record("sprint_40", 42.5)
check(json.decode(files["record.json"]).sprint_40 == 42.5, "record saved immediately")
Record = {}
save.load_record()
check(save.get_record("sprint_40") == 42.5, "record reload")
files["settings.json"] = json.encode({ display = { locale = "zh_cn", fullscreen = true }, game = { allow_user_script = true } })
fullscreen, has_locale = save.load()
check(has_locale and not fullscreen and not settings.game.allow_user_script, "native-only flags disabled on Web")
files["settings.json"], files["record.json"] = "{broken", "{broken"
save.load()
check(Settings.display.locale == "en" and next(Record) == nil, "invalid JSON falls back")
fail_write = true
check(not save.flush(), "failed writes reported")
fail_write = false
save.update(1)
check(json.decode(files["settings.json"]).display.locale == "en", "failed settings save retried")
platform.is_web = false
local before = writes
settings.sound.volume.bgm = 0.8
save.request_flush()
save.update(1)
check(writes == before, "desktop does not acquire web debounce")
save.flush()
check(writes == before + 1, "desktop explicit save still works")
print("PASS: Web native isolation, 256 glyph bytes, settings/record persistence and desktop save behavior")
