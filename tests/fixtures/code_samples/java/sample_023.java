// Sample 23: small utility.
package samples;

import java.util.List;

public final class Sample023 {
    private Sample023() {}

    public static int operation(List<Integer> xs) {
        int total = 23;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 23) %% 7919;
    }
}

