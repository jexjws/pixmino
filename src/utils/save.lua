-- Copyright (C) 2026 Sennoma-Nn
-- SPDX-License-Identifier: GPL-3.0-or-later

local save = {}

local settings = require("src.menu.settings")
local locale = require("src.manager.locale")
local sfx = require("src.manager.sfx")
local skin = require("src.manager.skin")
local json = require("lib.json")
local compatibility = require("src.utils.compatibility")
local platform = require("src.utils.platform")

local pending_flush

local function read_optional(path)
    if love.filesystem.getInfo(path, "file") then
        return love.filesystem.read(path)
    end
end

local function equal(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= "table" then return a == b end
    for key, value in pairs(a) do
        if not equal(value, b[key]) then return false end
    end
    for key in pairs(b) do
        if a[key] == nil then return false end
    end
    return true
end

local function write_json(path, value)
    local previous = read_optional(path)
    if previous then
        local ok, decoded = pcall(json.decode, previous)
        if ok and equal(decoded, value) then return true end
    end
    local text = json.encode(value)
    local ok, err = love.filesystem.write(path, text)
    if not ok then
        print("PIXMINO_SAVE_ERROR: " .. tostring(err))
    end
    return ok, err
end

function save.request_flush()
    if platform.is_web then pending_flush = pending_flush or 0.25 end
end

function save.update(dt)
    if not pending_flush then return end
    pending_flush = pending_flush - dt
    if pending_flush <= 0 then save.flush() end
end

local settings_file = "settings.json"
local record_file = "record.json"

local settings_roots = { "sound", "input", "display", "debug", "game" }

local function is_arr(t)
    for k in pairs(t) do
        if type(k) ~= "number" then
            return false
        end
    end
    return true
end

Record = {}

function save.flush_record()
    local t = {}
    for k, v in pairs(Record) do
        if v ~= nil then
            t[k] = v
        end
    end
    return write_json(record_file, t)
end

function save.load_record()
    Record = {}
    local text = read_optional(record_file)
    if text then
        local ok, decoded = pcall(json.decode, text)
        if ok and type(decoded) == "table" then
            for k, v in pairs(decoded) do
                Record[k] = tonumber(v) or v
            end
        end
    end
end

function save.get_record(mode_key)
    return Record[mode_key]
end

function save.update_record(mode_key, value)
    Record[mode_key] = value
    save.flush_record()
end

local function merge(dst, src)
    for k, v in pairs(src) do
        if type(v) == "table" and type(dst[k]) == "table" then
            if is_arr(v) then
                dst[k] = v
            else
                merge(dst[k], v)
            end
        else
            dst[k] = v
        end
    end
end

function save.flush()
    local t = {}
    local text = read_optional(settings_file)
    if text then
        local ok, decoded = pcall(json.decode, text)
        if ok and type(decoded) == "table" then
            t = decoded
        end
    end

    for i, root in ipairs(settings_roots) do
        t[root] = t[root] or {}
        merge(t[root], settings[root])
    end

    local ok, err = write_json(settings_file, t)
    pending_flush = not ok and platform.is_web and 1 or nil
    return ok, err
end

function save.load()
    compatibility.ini_setting_2_json()
    compatibility.ini_record_2_json()

    local has_locale = false

    local text = read_optional(settings_file)
    if text then
        local ok, decoded = pcall(json.decode, text)
        if ok and type(decoded) == "table" then
            for i, root in ipairs(settings_roots) do
                if type(decoded[root]) == "table" then
                    merge(settings[root], decoded[root])
                end
            end
            if type(decoded.display) == "table" and decoded.display.locale ~= nil then
                for i, lang in ipairs(locale.langs) do
                    if lang == decoded.display.locale then
                        settings.display.locale = lang
                        locale.current = lang
                        has_locale = true
                        break
                    end
                end
            end
        end
    end

    if not has_locale then
        settings.display.locale = "en"
        locale.current = "en"
    end

    sfx.set_bgm_volume(settings.sound.volume.bgm)
    sfx.set_sfx_volume(settings.sound.volume.sfx)

    local valid_skin = false
    for _, name in ipairs(skin.get_list()) do
        if name == settings.display.skin then
            valid_skin = true
            break
        end
    end
    if not valid_skin then
        settings.display.skin = "block"
    end

    if platform.is_web then
        settings.display.fullscreen = false
        settings.game.allow_user_script = false
    end
    local fullscreen = settings.display.fullscreen

    save.load_record()

    return fullscreen, has_locale
end

return save
