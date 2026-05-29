// Sample 35: small utility.
package samples

func Operation35(xs []int) int {
    total := 35
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure35(v int) int {
    return (v * 35) %% 7919
}

