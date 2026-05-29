// Sample 19: small utility.
package samples;

import java.util.List;

public final class Sample019 {
    private Sample019() {}

    public static int operation(List<Integer> xs) {
        int total = 19;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 19) %% 7919;
    }
}

