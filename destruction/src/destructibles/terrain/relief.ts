/**
 * The splat texture's alpha channel carries crater relief below the height-field resolution (the
 * 0.25 m grid holds the gross shape; shading uses this ~8 cm field): metres = code / 255 · SPAN − DEEP.
 */
export const RELIEF_DEEP = 2.0;
export const RELIEF_SPAN = 2.55;
