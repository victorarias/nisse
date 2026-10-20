return function(on)
  on("tool.call", { tool = "bash" }, function(nisse, e, next)
    if e.args.command:match("^rm ") then
      return { deny = "guard: no rm here" }
    end
    local ran = next(e)
    nisse.ui.status(ran.is_error and "last command failed" or "all green")
    return ran
  end)
end
