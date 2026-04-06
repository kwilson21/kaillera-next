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

/* Feed remote input. Call from JS when WebRTC delivers an input.
 * Returns: 0 = normal, 1 = misprediction detected (JS should replay)
 */
int kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy);

/* Pre-tick: save state to ring buffer, store local input, predict
 * missing remote inputs. Does NOT step the emulator.
 * Returns current frame number.
 */
int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy);

/* Post-tick: advance frame counter.
 * Returns the new frame number.
 */
int kn_post_tick(void);

/* Get the pending rollback frame, or -1 if none.
 * JS calls this to check if replay is needed. Clears the pending flag.
 */
int kn_get_pending_rollback(void);

/* Get pointer to saved state for a given frame.
 * Returns NULL if frame not in ring buffer.
 */
uint8_t* kn_get_state_for_frame(int frame);

/* Restore emulator state to a given frame from the ring buffer.
 * Calls retro_unserialize directly (synchronous, no asyncify).
 * Returns 1 on success, 0 on failure.
 */
int kn_restore_frame(int frame);

/* Get replay depth after kn_pre_tick. Returns frames to replay (0=none). Clears flag. */
int kn_get_replay_depth(void);

/* Get replay start frame (valid when kn_get_replay_depth > 0). */
int kn_get_replay_start(void);

/* Get the state buffer size (retro_serialize_size at init). */
int kn_get_state_size(void);

/* Get input for a given slot and frame.
 * Writes to out_buttons, out_lx, out_ly, out_cx, out_cy.
 * Returns 1 if present, 0 if not.
 */
int kn_get_input(int slot, int frame, int *out_buttons,
                 int *out_lx, int *out_ly, int *out_cx, int *out_cy);

/* Stats for UI overlay */
int kn_get_frame(void);
int kn_get_rollback_count(void);
int kn_get_prediction_count(void);
int kn_get_correct_predictions(void);
int kn_get_max_depth(void);

/* Full state hash — hashes the last retro_serialize output from the ring buffer. */
uint32_t kn_full_state_hash(void);

/* Determinism self-test. Returns 1 if restore+replay is deterministic, 0 if not. */
int kn_rollback_self_test(void);

/* Debug log ring buffer. Returns pointer to null-terminated string. */
const char* kn_get_debug_log(void);

/* Update player count (e.g., late join adds a player). */
void kn_set_num_players(int num_players);

/* Configure RNG sync for C-level replay. Pass RDRAM pointers for RNG seed addresses. */
void kn_set_rng_sync(uint32_t base_seed, uint32_t *rng_ptr, uint32_t *rng_alt_ptr);

/* Cleanup */
void kn_rollback_shutdown(void);

#endif /* KN_ROLLBACK_H */
