/* A stand-in for the emulator core, so the real rollback engine
 * (build/kn_rollback/kn_rollback.c) runs natively under pytest.
 *
 * The whole emulator state is one marker: whose timeline it is on and the
 * frame it is the start of. retro_serialize copies it into a ring slot and
 * retro_unserialize loads it back, which is all the engine's default state
 * backend does with a state. The test sets the marker the way running a
 * frame, or loading a resync's state, would leave it. Everything else the
 * engine calls in the core does nothing. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
    int32_t origin; /* KN_TEST_OWN or KN_TEST_HOST */
    int32_t frame;
} kn_test_state_t;

static kn_test_state_t g_live;

/* RDRAM, read by the hash registry each tick. All zeros. */
static uint8_t g_rdram[0x800000];

void kn_test_set_live(int32_t origin, int32_t frame) {
    g_live.origin = origin;
    g_live.frame = frame;
}

int32_t kn_test_live_origin(void) { return g_live.origin; }
int32_t kn_test_live_frame(void) { return g_live.frame; }

size_t retro_serialize_size(void) { return sizeof(g_live); }

bool retro_serialize(void *data, size_t size) {
    if (size < sizeof(g_live)) return false;
    memcpy(data, &g_live, sizeof(g_live));
    return true;
}

bool retro_unserialize(const void *data, size_t size) {
    if (size < sizeof(g_live)) return false;
    memcpy(&g_live, data, sizeof(g_live));
    return true;
}

void retro_run(void) {}

void *kn_get_rdram_ptr(void) { return g_rdram; }
uint32_t kn_get_rdram_size(void) { return (uint32_t)sizeof(g_rdram); }

int kn_headless = 0;
void kn_set_headless(int enable) { kn_headless = enable; }
void kn_set_frame_time(double time_ms) { (void)time_ms; }
void kn_reset_audio(void) {}
void kn_write_controller(int slot, int buttons, int lx, int ly, int cx, int cy) {
    (void)slot; (void)buttons; (void)lx; (void)ly; (void)cx; (void)cy;
}
uint32_t kn_sync_read_cpu(uint8_t *buf, uint32_t max_size) { (void)buf; (void)max_size; return 0; }
int kn_sync_write_cpu(const uint8_t *buf, uint32_t size) { (void)buf; (void)size; return 0; }
void kn_pack_hidden_state_impl(uint32_t *out) { (void)out; }
void kn_restore_hidden_state_impl(const uint32_t *in) { (void)in; }
uint32_t kn_get_hidden_state_fingerprint_impl(void) { return 0; }
/* The engine refuses to start without room for the HLE state; it is never read here. */
int kn_hle_state_size(void) { return 16; }
void kn_hle_save_to(uint8_t *buf) { (void)buf; }
void kn_hle_restore_from(const uint8_t *buf) { (void)buf; }
int kn_normalize_events_flag = 0;
void kn_normalize_event_queue(void) {}
uint_fast8_t softfloat_roundingMode = 0;
uint_fast8_t softfloat_exceptionFlags = 0;
