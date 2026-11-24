export type Tool = "pen" | "arrow" | "rectangle";
type Point = { x: number; y: number };
type Stroke = { tool: Tool; color: string; width: number; points: Point[] };
export class Drawing {
  tool: Tool = "pen";
  color = "#e5484d";
  width = 4;
  strokes: Stroke[] = [];
  current: Stroke | null = null;
  background: HTMLImageElement | null = null;
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
        canvas.setPointerCapture(e.pointerId);
        this.current = {
          tool: this.tool,
          color: this.color,
          width: this.width,
          points: [this.point(e)],
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
        if (this.tool === "pen") this.current.points.push(p);
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
