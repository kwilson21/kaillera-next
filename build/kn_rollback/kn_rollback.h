#ifndef KN_ROLLBACK_H
#define KN_ROLLBACK_H

#include <stdint.h>

/* Initialize rollback system. Call once after emulator boots.
 * max_frames: rollback window depth (typically 7-12 based on RTT)
 * delay_frames: input delay (typically 2-3)
 * local_slot: this player's controller slot (0-3)
 * num_players: total player count
 */
void kn_rollback_init(int max_frames, int delay_frames, int local_slot, int num_players);

/* Feed remote input. Call from JS when WebRTC delivers an input. */
void kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy);

/* Pre-tick: save state, store local input, predict remote inputs, write
 * inputs to controller registers. If a misprediction is pending, performs
 * the C-level replay (retro_unserialize + N x retro_run) BEFORE the
 * normal frame step.
 *
 * Call BEFORE the JS runner steps the emulator (stepOneFrame).
 * Returns current frame number.
 */
int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy);

/* Post-tick: advance frame counter. Call AFTER JS runner steps the emulator.
 * Returns the new frame number.
 */
int kn_post_tick(void);

/* Stats for UI overlay */
int kn_get_frame(void);
int kn_get_rollback_count(void);
int kn_get_prediction_count(void);
int kn_get_correct_predictions(void);
int kn_get_max_depth(void);

/* Determinism self-test. Returns 1 if restore+replay is deterministic, 0 if not. */
int kn_rollback_self_test(void);

/* Debug log ring buffer. Returns pointer to null-terminated string. */
const char* kn_get_debug_log(void);

/* Cleanup */
void kn_rollback_shutdown(void);

#endif /* KN_ROLLBACK_H */
