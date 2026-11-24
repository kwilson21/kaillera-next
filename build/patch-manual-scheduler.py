"""Route Emscripten main-loop scheduling to the module's lockstep owner."""
from pathlib import Path
import sys


def patch(glue):
    def replace(old, new):
        nonlocal glue
        if glue.count(old) != 1:
            raise ValueError(f"Expected one Emscripten glue site: {old}")
        glue = glue.replace(old, new)

    # The blocker bypasses MainLoop.scheduler and directly posts a timer.
    for native in (
        "setTimeout(MainLoop.runner,timeUntilNextTick)",
        "MainLoop.requestAnimationFrame(MainLoop.runner)",
        "MainLoop.setImmediate(MainLoop.runner)",
        "setTimeout(MainLoop.runner,0)",
    ):
        replace(native, f"if(MainLoop.manualScheduler)MainLoop.manualScheduler(MainLoop.runner);else {native}")

    replace("var MainLoop={running:false", "var MainLoop={manualScheduler:null,running:false")
    replace("var AL={", 'Module["knSetManualScheduler"]=owner=>{MainLoop.manualScheduler=owner};var AL={')

    # Paused generations must not drain the next generation's blocker queue.
    replace("if(ABORT)return;if(MainLoop.queue.length", "if(ABORT||!checkIsRunning())return false;if(MainLoop.queue.length")
    replace("setTimeout(MainLoop.runner,0);return}if(!checkIsRunning())return;", "setTimeout(MainLoop.runner,0);return false}")
    replace("MainLoop.scheduler();return}else if(MainLoop.timingMode", "MainLoop.scheduler();return false}else if(MainLoop.timingMode")

    # runIter may return without dispatching when a preMainLoop hook vetoes it.
    replace("for(var post of MainLoop.postMainLoop){post()}", "for(var post of MainLoop.postMainLoop){post()}return true")
    replace("MainLoop.runIter(iterFunc);if(!checkIsRunning())return;MainLoop.scheduler()",
            "var dispatched=MainLoop.runIter(iterFunc)===true;if(checkIsRunning())MainLoop.scheduler();return dispatched")
    return glue


if __name__ == "__main__":
    path = Path(sys.argv[1])
    path.write_text(patch(path.read_text()))
