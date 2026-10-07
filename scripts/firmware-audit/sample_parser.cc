#include <algorithm>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#include "ogg_demuxer.h"

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    std::ifstream input(argv[1], std::ios::binary);
    if (!input) return 2;
    std::vector<unsigned char> data((std::istreambuf_iterator<char>(input)), {});
    if (data.empty()) return 2;
    for (int chunk : {1, 31, 1024, 4096}) {
        OggDemuxer demuxer;
        int count = 0, rate = 0;
        bool durations_ok = true;
        demuxer.OnPacket([&](const uint8_t*, int sample_rate, int duration, size_t) {
            ++count;
            rate = sample_rate;
            durations_ok = durations_ok && duration == 20;
        });
        for (size_t offset = 0; offset < data.size(); offset += chunk) {
            demuxer.Process(data.data() + offset, std::min(size_t(chunk), data.size() - offset));
        }
        std::cout << "chunk=" << chunk << " finish=" << demuxer.Finish()
                  << " error=" << demuxer.HasError() << " packets=" << count
                  << " all_20ms=" << durations_ok << " rate=" << rate << '\n';
        if (!demuxer.Finish() || demuxer.HasError() || count != 51 || !durations_ok || rate != 16000) return 1;
    }
}
