// Sample 36: small utility.
package samples;

import java.util.List;

public final class Sample036 {
    private Sample036() {}

    public static int operation(List<Integer> xs) {
        int total = 36;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 36) %% 7919;
    }
}

