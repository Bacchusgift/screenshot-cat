export type Tool = "pen" | "arrow" | "rectangle" | "text" | "number";
type Point = { x: number; y: number };
type Stroke = {
  tool: Tool;
  color: string;
  width: number;
  points: Point[];
  label?: string;
};
export class Drawing {
  tool: Tool = "pen";
  color = "#e5484d";
  width = 4;
  strokes: Stroke[] = [];
  current: Stroke | null = null;
  background: HTMLImageElement | null = null;
  requestText?: (point: Point, commit: (text: string) => void) => void;
  private ctx: CanvasRenderingContext2D;
  private abort = new AbortController();
  constructor(
    public canvas: HTMLCanvasElement,
    w: number,
    h: number,
  ) {
    canvas.width = w;
    canvas.height = h;
    this.ctx = canvas.getContext("2d")!;
    const options = { signal: this.abort.signal };
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;
        const point = this.point(e);
        if (this.tool === "text" || this.tool === "number") {
          const { tool, color, width } = this;
          const add = (label: string) => {
            if (!label.trim()) return;
            this.strokes.push({ tool, color, width, points: [point], label });
            this.render();
          };
          if (tool === "number") {
            add(
              String(
                this.strokes.filter((stroke) => stroke.tool === "number")
                  .length + 1,
              ),
            );
          } else {
            e.preventDefault();
            this.requestText?.(point, add);
          }
          return;
        }
        canvas.setPointerCapture(e.pointerId);
        this.current = {
          tool: this.tool,
          color: this.color,
          width: this.width,
          points: [point],
        };
        this.render();
      },
      options,
    );
    canvas.addEventListener(
      "pointermove",
      (e) => {
        if (!this.current) return;
        const p = this.point(e);
        if (this.current.tool === "pen") this.current.points.push(p);
        else this.current.points[1] = p;
        this.render();
      },
      options,
    );
    const end = () => {
      if (this.current) {
        this.strokes.push(this.current);
        this.current = null;
        this.render();
      }
    };
    canvas.addEventListener("pointerup", end, options);
    canvas.addEventListener(
      "pointercancel",
      () => {
        this.current = null;
        this.render();
      },
      options,
    );
  }
  private point(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * this.canvas.width) / r.width,
      y: ((e.clientY - r.top) * this.canvas.height) / r.height,
    };
  }
  render() {
    const c = this.ctx;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.background) c.drawImage(this.background, 0, 0);
    for (const stroke of [
      ...this.strokes,
      ...(this.current ? [this.current] : []),
    ]) {
      const p = stroke.points;
      const a = p[0],
        b = p.at(-1)!;
      c.strokeStyle = stroke.color;
      c.fillStyle = stroke.color;
      c.lineWidth = stroke.width;
      c.lineCap = "round";
      c.lineJoin = "round";
      c.beginPath();
      if (stroke.label !== undefined) {
        c.save();
        c.textBaseline = "middle";
        c.textAlign = stroke.tool === "number" ? "center" : "left";
        const radius = Math.max(12, stroke.width * 4);
        c.font = `bold ${stroke.tool === "number" ? radius * 1.15 : Math.max(18, stroke.width * 6)}px system-ui, sans-serif`;
        if (stroke.tool === "number") {
          c.arc(a.x, a.y, radius, 0, Math.PI * 2);
          c.fill();
          c.strokeStyle = "#fff";
          c.lineWidth = Math.max(1, stroke.width / 2);
          c.stroke();
          c.fillStyle = "#fff";
        } else {
          c.strokeStyle = "#fff";
          c.lineWidth = Math.max(2, stroke.width / 2);
          c.strokeText(stroke.label, a.x, a.y);
        }
        c.fillText(stroke.label, a.x, a.y);
        c.restore();
        continue;
      }
      if (stroke.tool === "rectangle") {
        c.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        continue;
      }
      c.moveTo(a.x, a.y);
      for (const point of p) c.lineTo(point.x, point.y);
      if (p.length === 1) c.lineTo(a.x + 0.01, a.y + 0.01);
      c.stroke();
      if (stroke.tool === "arrow" && p.length > 1) {
        const angle = Math.atan2(b.y - a.y, b.x - a.x),
          size = Math.max(14, stroke.width * 4);
        c.beginPath();
        c.moveTo(b.x, b.y);
        c.lineTo(
          b.x - size * Math.cos(angle - 0.45),
          b.y - size * Math.sin(angle - 0.45),
        );
        c.moveTo(b.x, b.y);
        c.lineTo(
          b.x - size * Math.cos(angle + 0.45),
          b.y - size * Math.sin(angle + 0.45),
        );
        c.stroke();
      }
    }
  }
  undo() {
    this.strokes.pop();
    this.render();
  }
  clear() {
    this.strokes = [];
    this.render();
  }
  destroy() {
    this.abort.abort();
  }
}
