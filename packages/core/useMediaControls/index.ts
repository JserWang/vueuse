import { watch, ref, unref, watchEffect } from 'vue-demi'
import { isObject, MaybeRef, isString, ignorableWatch, isNumber, tryOnUnmounted, Fn, createEventHook } from '@vueuse/shared'
import { useEventListener } from '../useEventListener'
import { ConfigurableDocument, defaultDocument } from '../_configurable'

/**
 * Many of the jsdoc definitions here are modified version of the
 * documentation from MDN(https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement)
 */

export interface UseMediaSource {
  /**
   * The source url for the media
   */
  src: string

  /**
   * The media codec type
   */
  type?: string
}

export interface UseMediaTextTrackSource {
  /**
   * Indicates that the track should be enabled unless the user's preferences indicate
   * that another track is more appropriate
   */
  default?: boolean

  /**
   * How the text track is meant to be used. If omitted the default kind is subtitles.
   */
  kind: TextTrackKind

  /**
   * A user-readable title of the text track which is used by the browser
   * when listing available text tracks.
   */
  label: string

  /**
   * Address of the track (.vtt file). Must be a valid URL. This attribute
   * must be specified and its URL value must have the same origin as the document
   */
  src: string

  /**
   * Language of the track text data. It must be a valid BCP 47 language tag.
   * If the kind attribute is set to subtitles, then srclang must be defined.
   */
  srcLang: string
}

interface UseMediaControlsOptions extends ConfigurableDocument {
  /**
   * The source for the media, may either be a string, a `UseMediaSource` object, or a list
   * of `UseMediaSource` objects.
   */
  src?: MaybeRef<string | UseMediaSource | UseMediaSource[]>

  /**
   * A URL for an image to be shown while the media is downloading. If this attribute
   * isn't specified, nothing is displayed until the first frame is available,
   * then the first frame is shown as the poster frame.
   */
  poster?: MaybeRef<string>

  /**
   * Indicates that the media automatically begins to play back as soon as it
   * can do so without stopping to finish loading the data.
   *
   * @default false
   */
  autoplay?: MaybeRef<boolean>

  /**
   * Indicates that the media is to be played "inline", that is within the
   * element's playback area. Note that the absence of this attribute does
   * not imply that the media will always be played in fullscreen.
   *
   * @default auto
   */
  preload?: MaybeRef<'auto' | 'metadata' | 'none' >

  /**
   * If specified, the browser will automatically seek back to the start
   * upon reaching the end of the media.
   *
   * @default false
   */
  loop?: MaybeRef<boolean>

  /**
   * If true, the browser will offer controls to allow the user to control
   * media playback, including volume, seeking, and pause/resume playback.
   *
   * @default false
   */
  controls?: MaybeRef<boolean>

  /**
   * If true, the audio will be initially silenced. Its default value is false,
   * meaning that the audio will be played when the media is played.
   *
   * @default false
   */
  muted?: MaybeRef<boolean>

  /**
   * Indicates that the video is to be played "inline", that is within the element's
   * playback area. Note that the absence of this attribute does not imply
   * that the video will always be played in fullscreen.
   *
   * @default false
   */
  playsinline?: MaybeRef<boolean>

  /**
   * A Boolean attribute which if true indicates that the element should automatically
   * toggle picture-in-picture mode when the user switches back and forth between
   * this document and another document or application.
   *
   * @default false
   */
  autoPictureInPicture?: MaybeRef<boolean>

  /**
   * A list of text tracks for the media
   */
  tracks?: MaybeRef<UseMediaTextTrackSource[]>
}

export interface UseMediaTextTrack {
  /**
   * The index of the text track
   */
  id: number

  /**
   * The text track label
   */
  label: string

  /**
   * Language of the track text data. It must be a valid BCP 47 language tag.
   * If the kind attribute is set to subtitles, then srclang must be defined.
   */
  language: string

  /**
   * Specifies the display mode of the text track, either `disabled`,
   * `hidden`, or `showing`
   */
  mode: TextTrackMode

  /**
   * How the text track is meant to be used. If omitted the default kind is subtitles.
   */
  kind: TextTrackKind

  /**
   * Indicates the track's in-band metadata track dispatch type.
   */
  inBandMetadataTrackDispatchType: string

  /**
   * A list of text track cues
   */
  cues: TextTrackCueList | null

  /**
   * A list of active text track cues
   */
  activeCues: TextTrackCueList | null
}

/**
 * Automatically check if the ref exists and if it does run the cb fn
 */
function usingElRef<T = any>(source: MaybeRef<any>, cb: (el: T) => void) {
  if (unref(source))
    cb(unref(source))
}

/**
 * Converts a TimeRange object to an array
 */
function timeRangeToArray(timeRanges: TimeRanges) {
  let ranges: [number, number][] = []

  for (let i = 0; i < timeRanges.length; ++i)
    ranges = [...ranges, [timeRanges.start(i), timeRanges.end(i)]]

  return ranges
}

/**
 * Converts a TextTrackList object to an array of `UseMediaTextTrack`
 */
function tracksToArray(tracks: TextTrackList): UseMediaTextTrack[] {
  return Array.from(tracks)
    .map(({ label, kind, language, mode, activeCues, cues, inBandMetadataTrackDispatchType }, id) =>
      ({ id, label, kind, language, mode, activeCues, cues, inBandMetadataTrackDispatchType }))
}

const defaultOptions: UseMediaControlsOptions = {
  src: '',
  tracks: [],
}

export function useMediaControls(target: MaybeRef<HTMLMediaElement | null | undefined>, options: UseMediaControlsOptions = {}) {
  options = {
    ...defaultOptions,
    ...options,
  }

  const {
    document = defaultDocument,
  } = options

  const currentTime = ref(0)
  const duration = ref(0)
  const seeking = ref(false)
  const buffering = ref(false)
  const volume = ref(1)
  const waiting = ref(false)
  const ended = ref(false)
  const playing = ref(false)
  const rate = ref(1)
  const stalled = ref(false)
  const buffered = ref<[number, number][]>([])
  const tracks = ref<UseMediaTextTrack[]>([])
  const selectedTrack = ref<number>(-1)
  const isPictureInPicture = ref(false)

  const supportsPictureInPicture = document && 'pictureInPictureEnabled' in document

  // Events
  const sourceErrorEvent = createEventHook<Event>()

  /**
   * Disables the specified track. If no track is specified then
   * all tracks will be disabled
   *
   * @param track The id of the track to disable
   */
  const disableTrack = (track?: number | UseMediaTextTrack) => {
    usingElRef<HTMLMediaElement>(target, (el) => {
      if (track) {
        const id = isNumber(track) ? track : track.id
        el.textTracks[id].mode = 'disabled'
      }
      else {
        for (let i = 0; i < el.textTracks.length; ++i)
          el.textTracks[i].mode = 'disabled'
      }

      selectedTrack.value = -1
    })
  }

  /**
   * Enables the specified track and disables the
   * other tracks unless otherwise specified
   *
   * @param track The track of the id of the track to enable
   * @param disableTracks Disable all other tracks
   */
  const enableTrack = (track: number | UseMediaTextTrack, disableTracks = true) => {
    usingElRef<HTMLMediaElement>(target, (el) => {
      const id = isNumber(track) ? track : track.id

      if (disableTracks)
        disableTrack()

      el.textTracks[id].mode = 'showing'
      selectedTrack.value = id
    })
  }
  /**
   * Toggle picture in picture mode for the player.
   */
  const togglePictureInPicture = () => {
    return new Promise((resolve, reject) => {
      usingElRef<HTMLVideoElement>(target, async(el) => {
        if (supportsPictureInPicture) {
          if (!isPictureInPicture.value) {
            (el as any).requestPictureInPicture()
              .then(resolve)
              .catch(reject)
          }
          else {
            (document as any).exitPictureInPicture()
              .then(resolve)
              .catch(reject)
          }
        }
      })
    })
  }

  // Apply Options
  watchEffect(() => {
    const el = unref(target)
    if (!el)
      return

    const loop = unref(options.loop)
    if (loop !== undefined) el.loop = loop

    const controls = unref(options.controls)
    if (controls !== undefined) el.controls = controls

    const muted = unref(options.muted)
    if (muted !== undefined) el.muted = muted

    const preload = unref(options.preload)
    if (preload !== undefined) el.preload = preload

    const autoplay = unref(options.autoplay)
    if (autoplay !== undefined) el.autoplay = autoplay

    const poster = unref(options.poster)
    if (poster !== undefined) (el as HTMLVideoElement).poster = poster

    const playsInline = unref(options.playsinline)
    if (playsInline !== undefined) (el as HTMLVideoElement).playsInline = playsInline

    const autoPictureInPicture = unref(options.autoPictureInPicture)
    // @ts-expect-error HTMLVideoElement.autoPictureInPicture not implemented in TS
    if (autoPictureInPicture !== undefined) (el as HTMLVideoElement).autoPictureInPicture = autoPictureInPicture

    el.volume = unref(volume)!
  })

  /**
   * This will automatically inject sources to the media element. The sources will be
   * appended as children to the media element as `<source>` elements.
   */
  watchEffect(() => {
    if (!document)
      return

    const el = unref(target)
    if (!el)
      return

    const src = unref(options.src)
    let sources: UseMediaSource[] = []

    if (!src)
      return

    // Merge sources into an array
    if (isString(src))
      sources = [{ src }]
    else if (Array.isArray(src))
      sources = src
    else if (isObject(src))
      sources = [src]

    // Clear the sources
    el.querySelectorAll('source').forEach((e) => {
      e.removeEventListener('error', sourceErrorEvent.trigger)
      e.remove()
    })

    // Add new sources
    sources.forEach(({ src, type }) => {
      const source = document.createElement('source')

      source.setAttribute('src', src)
      source.setAttribute('type', type || '')

      source.addEventListener('error', sourceErrorEvent.trigger)

      el.appendChild(source)
    })

    // Finally, load the new sources.
    el.load()
  })

  // Remove source error listeners
  tryOnUnmounted(() => {
    const el = unref(target)
    if (!el)
      return

    el.querySelectorAll('source').forEach(e => e.removeEventListener('error', sourceErrorEvent.trigger))
  })

  /**
   * Watch volume and change player volume when volume prop changes
   */
  watch(volume, (vol) => {
    const el = unref(target)
    if (!el)
      return

    el.volume = vol
  })

  /**
   * Load Tracks
   */
  watchEffect(() => {
    if (!document)
      return

    const textTracks = unref(options.tracks)
    const el = unref(target)

    if (!textTracks || !textTracks.length || !el)
      return

    /**
     * The MediaAPI provides an API for adding text tracks, but they don't currently
     * have an API for removing text tracks, so instead we will just create and remove
     * the tracks manually using the HTML api.
     */
    el.querySelectorAll('track').forEach(e => e.remove())

    textTracks.forEach(({ default: isDefault, kind, label, src, srcLang }, i) => {
      const track = document.createElement('track')

      track.default = isDefault || false
      track.kind = kind
      track.label = label
      track.src = src
      track.srclang = srcLang

      if (track.default)
        selectedTrack.value = i

      el.appendChild(track)
    })
  })

  /**
   * This will allow us to update the current time from the timeupdate event
   * without setting the medias current position, but if the user changes the
   * current time via the ref, then the media will seek.
   *
   * If we did not use an ignorable watch, then the current time update from
   * the timeupdate event would cause the media to stutter.
   */
  const { ignoreUpdates: ignoreCurrentTimeUpdates } = ignorableWatch(currentTime, (time) => {
    const el = unref(target)
    if (!el)
      return

    el.currentTime = time
  })

  /**
   * Using an ignorable watch so we can control the play state using a ref and not
   * a function
   */
  const { ignoreUpdates: ignorePlayingUpdates } = ignorableWatch(playing, (isPlaying) => {
    const el = unref(target)
    if (!el)
      return

    isPlaying ? el.play() : el.pause()
  })

  useEventListener(target, 'timeupdate', () => ignoreCurrentTimeUpdates(() => currentTime.value = (unref(target))!.currentTime))
  useEventListener(target, 'durationchange', () => duration.value = (unref(target))!.duration)
  useEventListener(target, 'progress', () => buffered.value = timeRangeToArray((unref(target))!.buffered))
  useEventListener(target, 'seeking', () => seeking.value = true)
  useEventListener(target, 'seeked', () => seeking.value = false)
  useEventListener(target, 'waiting', () => waiting.value = true)
  useEventListener(target, 'playing', () => waiting.value = false)
  useEventListener(target, 'ratechange', () => rate.value = (unref(target))!.playbackRate)
  useEventListener(target, 'stalled', () => stalled.value = true)
  useEventListener(target, 'ended', () => ended.value = true)
  useEventListener(target, 'pause', () => ignorePlayingUpdates(() => playing.value = false))
  useEventListener(target, 'play', () => ignorePlayingUpdates(() => playing.value = true))
  useEventListener(target, 'enterpictureinpicture', () => isPictureInPicture.value = true)
  useEventListener(target, 'leavepictureinpicture', () => isPictureInPicture.value = false)

  /**
   * The following listeners need to listen to a nested
   * object on the target, so we will have to use a nested
   * watch and manually remove the listeners
   */
  const listeners: Fn[] = []

  const stop = watch([target], () => {
    const el = unref(target)
    if (!el)
      return

    stop()

    listeners[0] = useEventListener(el.textTracks, 'addtrack', () => tracks.value = tracksToArray(el.textTracks))
    listeners[1] = useEventListener(el.textTracks, 'removetrack', () => tracks.value = tracksToArray(el.textTracks))
    listeners[2] = useEventListener(el.textTracks, 'change', () => tracks.value = tracksToArray(el.textTracks))
  })

  // Remove text track listeners
  tryOnUnmounted(() => listeners.forEach(listener => listener()))

  return {
    currentTime,
    duration,
    buffering,
    waiting,
    seeking,
    ended,
    stalled,
    buffered,
    playing,
    volume,

    // Tracks
    tracks,
    selectedTrack,
    enableTrack,
    disableTrack,

    // Picture in Picture
    supportsPictureInPicture,
    togglePictureInPicture,
    isPictureInPicture,

    // Events
    onSourceError: sourceErrorEvent.on,
  }
}
