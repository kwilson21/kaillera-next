/* A stand-in for the emulator core, so the real rollback engine
 * (build/kn_rollback/kn_rollback.c) runs natively under pytest.
 *
 * The emulator state is RDRAM with a marker at its start: whose timeline
 * the state is on and the frame it is the start of. Block 5 of RDRAM (the
 * engine's 64 KB blocks) holds the frame's low byte, so it changes every
 * frame and is the same on both timelines. The engine's two state backends
 * read it their own way: retro_serialize copies the marker, the split-RDRAM
 * backend copies RDRAM and the small CPU state below. The test sets the
 * marker the way running a frame, or loading a resync's state, would leave
 * it. kn_write_controller records the input each controller was last given.
 * Everything else the engine calls in the core does nothing. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
    int32_t origin; /* 1 = the page's own timeline, 2 = the host's */
    int32_t frame;
} kn_test_state_t;

#define KN_TEST_BLOCK_SIZE (0x800000 / 128)
#define KN_TEST_FRAME_BLOCK 5

static uint8_t g_rdram[0x800000];

static kn_test_state_t *live(void) { return (kn_test_state_t *)g_rdram; }

void kn_test_set_live(int32_t origin, int32_t frame) {
    live()->origin = origin;
    live()->frame = frame;
    g_rdram[KN_TEST_FRAME_BLOCK * KN_TEST_BLOCK_SIZE] = (uint8_t)frame;
}

int32_t kn_test_live_origin(void) { return live()->origin; }
int32_t kn_test_live_frame(void) { return live()->frame; }
int32_t kn_test_live_frame_block(void) { return g_rdram[KN_TEST_FRAME_BLOCK * KN_TEST_BLOCK_SIZE]; }

size_t retro_serialize_size(void) { return sizeof(kn_test_state_t); }

bool retro_serialize(void *data, size_t size) {
    if (size < sizeof(kn_test_state_t)) return false;
    memcpy(data, live(), sizeof(kn_test_state_t));
    return true;
}

bool retro_unserialize(const void *data, size_t size) {
    if (size < sizeof(kn_test_state_t)) return false;
    const kn_test_state_t *s = (const kn_test_state_t *)data;
    kn_test_set_live(s->origin, s->frame);
    return true;
}

void retro_run(void) {}

void *kn_get_rdram_ptr(void) { return g_rdram; }
uint32_t kn_get_rdram_size(void) { return (uint32_t)sizeof(g_rdram); }

/* The split backend's CPU half: a few bytes the engine stores and restores. */
uint32_t kn_sync_read_cpu(uint8_t *buf, uint32_t max_size) {
    if (max_size < 4) return 0;
    memset(buf, 0, 4);
    return 4;
}
int kn_sync_write_cpu(const uint8_t *buf, uint32_t size) { (void)buf; (void)size; return 0; }

int kn_headless = 0;
void kn_set_headless(int enable) { kn_headless = enable; }
void kn_set_frame_time(double time_ms) { (void)time_ms; }
void kn_reset_audio(void) {}
/* The last input the engine wrote to each controller: buttons, lx, ly, cx,
 * cy. A test reads it after kn_pre_tick to see what the frame runs with. */
int32_t kn_test_controller[4][5];
void kn_write_controller(int slot, int buttons, int lx, int ly, int cx, int cy) {
    if (slot < 0 || slot >= 4) return;
    kn_test_controller[slot][0] = buttons;
    kn_test_controller[slot][1] = lx;
    kn_test_controller[slot][2] = ly;
    kn_test_controller[slot][3] = cx;
    kn_test_controller[slot][4] = cy;
}
int32_t kn_test_controller_buttons(int slot) {
    return (slot < 0 || slot >= 4) ? 0 : kn_test_controller[slot][0];
}
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
