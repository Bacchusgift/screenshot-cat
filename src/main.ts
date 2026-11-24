import "./icons.css";
import "./style.css";
import { handleError } from "./bridge";
const view = new URLSearchParams(location.search).get("view");
if (view === "clipboard")
  import("./clipboard").then((m) => m.clipboard()).catch(handleError);
else if (view) {
  import("./utility")
    .then((m) => {
      if (view === "overlay") return m.overlay();
      if (view === "controls") return m.controls();
      if (view === "pin") return m.pin();
    })
    .catch(handleError);
} else import("./app").then((m) => m.launch()).catch(handleError);
