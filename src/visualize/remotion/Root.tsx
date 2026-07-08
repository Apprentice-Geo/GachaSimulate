import { Composition } from "remotion";
import { CdfComposition } from "./CdfComposition";
import {
  CDF_COMPOSITION_ID,
  CDF_DURATION_IN_FRAMES,
  CDF_VIDEO_FPS,
  CDF_VIDEO_HEIGHT,
  CDF_VIDEO_WIDTH,
} from "./constants";

export function RemotionRoot() {
  return (
    <Composition
      component={CdfComposition}
      durationInFrames={CDF_DURATION_IN_FRAMES}
      fps={CDF_VIDEO_FPS}
      height={CDF_VIDEO_HEIGHT}
      id={CDF_COMPOSITION_ID}
      width={CDF_VIDEO_WIDTH}
    />
  );
}
