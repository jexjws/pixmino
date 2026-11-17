-- Appended to main.lua only by scripts/test-love.mjs; never shipped in game packages.
do
    local game = require("src.game.game")
    local menu = require("src.menu.menu")
    local modes = require("src.manager.mode")
    local skin = require("src.manager.skin")
    local locale = require("src.manager.locale")
    local save = require("src.utils.save")
    local original_load, original_update, original_draw = love.load, love.update, love.draw
    local actions, index, drawn = {}, 0, false
    local results = {}

    local function stage(name, fn)
        actions[#actions + 1] = { name = name, run = fn }
    end
    local function fail(err)
        print("SMOKE_FAIL: " .. tostring(err))
        love.event.quit(1)
    end
    function love.load()
        original_load()
        love.math.setRandomSeed(42)
        assert(#locale.langs == 4, "all built-in languages loaded")
        for _, lang in ipairs(locale.langs) do
            local current = lang
            stage("language:" .. current, function()
                menu.set_language(current)
                assert(locale.current == current)
                menu.go_to("MENU_ABOUT")
            end)
        end
        for _, name in ipairs(skin.get_list()) do
            local current = name
            stage("skin:" .. current, function()
                game.stop()
                Settings.display.skin = current
                menu.start_game("sprint")
                original_update(1 / 60)
                for _ = 1, 120 do original_update(1 / 60) end
                assert(game.piece and not game.over, "skin game spawned")
                assert(skin.load(current), "skin loaded")
            end)
        end
        local names = {}
        for name, mode in pairs(modes) do
            if type(mode) == "table" then names[#names + 1] = name end
        end
        table.sort(names)
        for _, name in ipairs(names) do
            local current = name
            stage("mode:" .. current, function()
                game.stop()
                menu.start_game(current)
                for _ = 1, 125 do
                    original_update(1 / 60)
                    if game.piece then break end
                end
                assert(game.piece and not game.over, "mode spawned")
                game.move_left(); game.move_right()
                game.rotate_cw(); game.rotate_ccw(); game.rotate_180()
                game.do_hold(); game.soft_drop(); game.hard_drop()
                for _ = 1, 60 do original_update(1 / 60) end
                assert(not game.over, "mode continues after drop")
                game.open_modal()
                local before = game.time
                original_update(1)
                assert(game.time == before, "pause freezes gameplay")
                game.close_modal()
            end)
        end
        stage("save round trip", function()
            save.update_record("web_smoke", 42.5)
            Record = {}
            save.load_record()
            assert(save.get_record("web_smoke") == 42.5)
            Settings.sound.volume.bgm = 0.3
            assert(save.flush())
            Settings.sound.volume.bgm = 0.9
            save.load()
            assert(Settings.sound.volume.bgm == 0.3)
            game.stop()
            menu.set_language("en")
        end)
    end
    function love.update(dt)
        if not drawn then return end
        drawn = false
        index = index + 1
        local action = actions[index]
        if not action then
            print("SMOKE_PASS: " .. table.concat(results, ", "))
            love.event.quit(0)
            return
        end
        local ok, err = pcall(action.run)
        if not ok then fail(action.name .. ": " .. tostring(err)); return end
        results[#results + 1] = action.name
    end
    function love.draw()
        local ok, err = pcall(original_draw)
        if not ok then fail(err); return end
        drawn = true
    end
    function love.errorhandler(err) fail(err); return function() return 1 end end
end
