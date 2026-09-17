/**
 * The lit-up screen: four high-contrast full-screen animations on one canvas.
 *
 * Drawing stops completely when the turn ends, so an inactive phone is a black
 * canvas with no animation frame running and nothing drawn on it.
 */

const PALETTES: string[][] = [
  ['#ff2e63', '#ffd700', '#08d9d6'],
  ['#00e676', '#ffffff', '#2979ff'],
  ['#ff6d00', '#ffea00', '#d500f9'],
  ['#18ffff', '#f50057', '#ffffff'],
];

export class Visuals {
  private frame: number | null = null;
  private startedAt = 0;
  private variant = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('resize', () => this.resize());
  }

  start(variant: number): void {
    this.stop();
    this.variant = variant % PALETTES.length;
    this.startedAt = performance.now();
    this.resize();
    const loop = (time: number) => {
      this.draw((time - this.startedAt) / 1000);
      this.frame = window.requestAnimationFrame(loop);
    };
    this.frame = window.requestAnimationFrame(loop);
  }

  /** Stop and wipe to black. */
  stop(): void {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    const context = this.canvas.getContext('2d');
    if (context) context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(this.canvas.clientWidth * ratio);
    this.canvas.height = Math.floor(this.canvas.clientHeight * ratio);
  }

  private draw(seconds: number): void {
    const context = this.canvas.getContext('2d');
    if (!context) return;

    const width = this.canvas.width;
    const height = this.canvas.height;
    const colors = PALETTES[this.variant];
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);

    switch (this.variant) {
      case 0:
        this.pulsingRings(context, seconds, width, height, colors);
        break;
      case 1:
        this.spinningRays(context, seconds, width, height, colors);
        break;
      case 2:
        this.bouncingBlobs(context, seconds, width, height, colors);
        break;
      default:
        this.colorBands(context, seconds, width, height, colors);
        break;
    }
  }

  private pulsingRings(
    context: CanvasRenderingContext2D,
    seconds: number,
    width: number,
    height: number,
    colors: string[],
  ): void {
    const centerX = width / 2;
    const centerY = height / 2;
    const max = Math.hypot(width, height) / 2;
    for (let ring = 4; ring >= 0; ring -= 1) {
      const phase = (seconds * 0.8 + ring * 0.2) % 1;
      context.fillStyle = colors[ring % colors.length];
      context.beginPath();
      context.arc(centerX, centerY, max * phase, 0, Math.PI * 2);
      context.fill();
    }
  }

  private spinningRays(
    context: CanvasRenderingContext2D,
    seconds: number,
    width: number,
    height: number,
    colors: string[],
  ): void {
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.hypot(width, height);
    const rays = 12;
    for (let ray = 0; ray < rays; ray += 1) {
      const start = (ray / rays) * Math.PI * 2 + seconds * 0.9;
      context.fillStyle = colors[ray % colors.length];
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.arc(centerX, centerY, radius, start, start + Math.PI / rays);
      context.closePath();
      context.fill();
    }
  }

  private bouncingBlobs(
    context: CanvasRenderingContext2D,
    seconds: number,
    width: number,
    height: number,
    colors: string[],
  ): void {
    const radius = Math.min(width, height) / 5;
    for (let blob = 0; blob < 3; blob += 1) {
      const speedX = 0.6 + blob * 0.17;
      const speedY = 0.45 + blob * 0.23;
      const x = triangleWave(seconds * speedX + blob * 0.3) * (width - radius * 2) + radius;
      const y = triangleWave(seconds * speedY + blob * 0.7) * (height - radius * 2) + radius;
      context.fillStyle = colors[blob % colors.length];
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
  }

  private colorBands(
    context: CanvasRenderingContext2D,
    seconds: number,
    width: number,
    height: number,
    colors: string[],
  ): void {
    const bands = 6;
    const bandHeight = height / bands;
    for (let band = 0; band < bands; band += 1) {
      const shift = triangleWave(seconds * 0.7 + band * 0.25);
      context.fillStyle = colors[(band + Math.floor(seconds * 2)) % colors.length];
      context.fillRect(
        -width * 0.2 + shift * width * 0.4,
        band * bandHeight,
        width * 1.4,
        bandHeight,
      );
    }
  }
}

/** 0 → 1 → 0 with no jump at the wrap, which is what makes a blob bounce. */
function triangleWave(value: number): number {
  const wrapped = value % 2;
  const positive = wrapped < 0 ? wrapped + 2 : wrapped;
  return positive <= 1 ? positive : 2 - positive;
}
